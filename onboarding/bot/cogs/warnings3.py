"""
Three-Level Warning System cog — /warn slash-command group (v2.0).

Level 1 → friendly reminder (no punishment)
Level 2 → official warning (permanently stored)
Level 3 → automatic kick or ban (configurable), DM explanation,
          full audit trail + Telegram report.

Fully additive: the existing /security warnings command and the automatic
security-pipeline warnings keep working unchanged — this system reads the
same `warnings` table so auto-mod warnings also escalate the level.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Literal

import discord
from discord import app_commands
from discord.ext import commands

from bot.core.logging import get_logger
from bot.services.intel import reports
from bot.utils.formatting import utcnow

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("cogs.warnings3")

LEVEL_EMOJI = {1: "💬", 2: "⚠️", 3: "🔨"}

DEFAULT_L1 = (
    "Hey! Just a quick reminder to follow our community rules. "
    "We want everyone to have a great experience here. "
    "Thanks for understanding! 😊"
)
DEFAULT_L2 = (
    "⚠️ **Official Warning:** You have violated the server rules again. "
    "Please stop this behavior. Continued violations may result in removal "
    "from the server."
)
DEFAULT_L3 = (
    "🔨 You have been removed from **{server}** after receiving three "
    "warnings.\n\n**Final reason:** {reason}\n\n"
    "**Your warning history:**\n{history}\n\n"
    "If you believe this was a mistake, you may contact the server staff."
)


@app_commands.default_permissions(moderate_members=True)
@app_commands.guild_only()
class WarningSystem(commands.GroupCog, group_name="warn"):
    """Three-stage escalating moderation warnings."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot

    # ─────────────────────────────────────────────────────────
    # helpers
    # ─────────────────────────────────────────────────────────

    async def _dm(self, member: discord.Member, content: str,
                  embed: discord.Embed | None = None) -> bool:
        try:
            await member.send(content=content or None, embed=embed)
            return True
        except (discord.Forbidden, discord.HTTPException):
            return False

    @staticmethod
    def _history_text(history: list[dict]) -> str:
        if not history:
            return "—"
        lines = []
        for i, w in enumerate(history[:10], 1):
            ts = (w.get("created_at") or "")[:16].replace("T", " ")
            lines.append(f"{i}. {w.get('reason', '—')} ({ts})")
        return "\n".join(lines)

    async def _telegram(self, guild: discord.Guild, user_id: int,
                        event_type: str, text: str) -> None:
        settings = await self.bot.db.get_guild_settings(guild.id)
        if settings.get("enable_telegram", 1):
            await self.bot.telegram.send(
                text, event_type=event_type, guild_id=guild.id, user_id=user_id)

    # ─────────────────────────────────────────────────────────
    # /warn issue
    # ─────────────────────────────────────────────────────────

    @app_commands.command(name="issue", description="Warn a member (3-level escalating system)")
    @app_commands.describe(member="Member to warn", reason="Why are they being warned?")
    async def issue(self, interaction: discord.Interaction,
                    member: discord.Member, reason: str) -> None:
        assert interaction.guild is not None
        guild = interaction.guild
        moderator = interaction.user

        # guard rails
        if member.id == moderator.id:
            await interaction.response.send_message(
                "❌ You cannot warn yourself.", ephemeral=True)
            return
        if member.bot:
            await interaction.response.send_message(
                "❌ You cannot warn a bot.", ephemeral=True)
            return
        if isinstance(moderator, discord.Member) and \
                member.top_role >= moderator.top_role and \
                guild.owner_id != moderator.id:
            await interaction.response.send_message(
                "❌ You cannot warn a member with an equal or higher role.",
                ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)

        store = self.bot.security_store
        intel = self.bot.intel_store
        ws = await intel.get_warning_settings(guild.id)

        # existing warnings BEFORE this one → determines new level
        prior = await store.warning_count(guild.id, member.id)
        level = min(prior + 1, 3)

        # persist the warning permanently (same table the security engine uses)
        count = await store.add_warning(
            guild_id=guild.id, user_id=member.id, username=str(member),
            reason=reason, event_type=f"manual_l{level}",
            moderator_id=moderator.id,
        )

        history_rows = await self.bot.db.fetchall(
            "SELECT reason, created_at FROM warnings "
            "WHERE guild_id = ? AND user_id = ? ORDER BY id",
            (guild.id, member.id))
        history = [dict(r) for r in history_rows]

        if level == 1:
            await self._handle_level1(interaction, member, reason, ws, count, history)
        elif level == 2:
            await self._handle_level2(interaction, member, reason, ws, count, history)
        else:
            await self._handle_level3(interaction, member, reason, ws, count, history)

    # ── level handlers ───────────────────────────────────────

    async def _handle_level1(self, interaction, member, reason, ws,
                             count, history) -> None:
        guild = interaction.guild
        msg = ws.get("level1_message") or DEFAULT_L1
        embed = discord.Embed(
            title=f"💬 Friendly Reminder — {guild.name}",
            description=f"{msg}\n\n**Context:** {reason}",
            color=discord.Color.blue(), timestamp=utcnow(),
        )
        embed.set_footer(text="Level 1 of 3 • No action taken")
        dm_ok = bool(ws.get("dm_on_warn", 1)) and await self._dm(member, "", embed)

        await self.bot.intel_store.add_mod_action(
            guild_id=guild.id, user_id=member.id, username=str(member),
            action="warn_l1", level=1, reason=reason,
            moderator_id=interaction.user.id, moderator_tag=str(interaction.user),
            dm_delivered=dm_ok, history=history,
        )
        await self._telegram(guild, member.id, "warn_level1",
                             reports.warning_issued({
                                 "level_emoji": "💬", "level": 1,
                                 "username": str(member), "user_id": member.id,
                                 "moderator": str(interaction.user),
                                 "reason": reason, "count": count,
                                 "dm": "✅" if dm_ok else "❌",
                                 "action": "friendly reminder only",
                                 "server_name": guild.name,
                             }))
        await interaction.followup.send(
            f"💬 **Level 1** friendly reminder sent to **{member}** "
            f"({count} warning{'s' if count != 1 else ''} on record). "
            f"DM: {'✅ delivered' if dm_ok else '❌ closed'}",
            ephemeral=True)

    async def _handle_level2(self, interaction, member, reason, ws,
                             count, history) -> None:
        guild = interaction.guild
        msg = ws.get("level2_message") or DEFAULT_L2
        embed = discord.Embed(
            title=f"⚠️ Official Warning — {guild.name}",
            description=(
                f"{msg}\n\n**Reason:** {reason}\n\n"
                f"**Previous warnings:**\n{self._history_text(history[:-1])}"
            ),
            color=discord.Color.orange(), timestamp=utcnow(),
        )
        embed.set_footer(
            text="Level 2 of 3 • One more warning will result in removal")
        dm_ok = bool(ws.get("dm_on_warn", 1)) and await self._dm(member, "", embed)

        await self.bot.intel_store.add_mod_action(
            guild_id=guild.id, user_id=member.id, username=str(member),
            action="warn_l2", level=2, reason=reason,
            moderator_id=interaction.user.id, moderator_tag=str(interaction.user),
            dm_delivered=dm_ok, history=history,
        )
        await self._telegram(guild, member.id, "warn_level2",
                             reports.warning_issued({
                                 "level_emoji": "⚠️", "level": 2,
                                 "username": str(member), "user_id": member.id,
                                 "moderator": str(interaction.user),
                                 "reason": reason, "count": count,
                                 "dm": "✅" if dm_ok else "❌",
                                 "action": "official warning stored",
                                 "server_name": guild.name,
                             }))
        await interaction.followup.send(
            f"⚠️ **Level 2** official warning issued to **{member}** "
            f"({count} warnings). Next warning triggers "
            f"**{ws.get('level3_action', 'kick')}**. "
            f"DM: {'✅ delivered' if dm_ok else '❌ closed'}",
            ephemeral=True)

    async def _handle_level3(self, interaction, member, reason, ws,
                             count, history) -> None:
        guild = interaction.guild
        action = (ws.get("level3_action") or "kick").lower()
        if action not in ("kick", "ban"):
            action = "kick"
        history_text = self._history_text(history)

        # 1) DM explanation BEFORE removal (can't DM after they're gone)
        template = ws.get("level3_message") or DEFAULT_L3
        dm_text = template.format(
            server=guild.name, reason=reason, history=history_text)
        embed = discord.Embed(
            title=f"🔨 Removed from {guild.name}",
            description=dm_text,
            color=discord.Color.red(), timestamp=utcnow(),
        )
        embed.set_footer(text="Level 3 of 3 • Final action")
        dm_ok = await self._dm(member, "", embed)

        # 2) execute the configured removal via the shared ActionExecutor
        #    (full permission/hierarchy checks + punishments audit table)
        full_reason = f"3-level warning system: {reason} (warning #{count})"
        if action == "ban":
            ok = await self.bot.action_executor.ban(
                member, reason=full_reason, event_type="warn_l3",
                moderator_id=interaction.user.id)
        else:
            ok = await self.bot.action_executor.kick(
                member, reason=full_reason, event_type="warn_l3",
                moderator_id=interaction.user.id)

        # 3) audit everything
        await self.bot.intel_store.add_mod_action(
            guild_id=guild.id, user_id=member.id, username=str(member),
            action=f"warn_l3_{action}", level=3, reason=reason,
            moderator_id=interaction.user.id, moderator_tag=str(interaction.user),
            dm_delivered=dm_ok, history=history,
        )
        await self.bot.security_store.log_event(
            guild_id=guild.id, user_id=member.id, username=str(member),
            event_type="manual",
            evidence=f"level 3 warning → {action} | history={json.dumps(history)[:800]}",
            action_taken=action if ok else f"{action} FAILED",
            moderator_id=interaction.user.id,
        )
        await self.bot.intel_store.add_member_event(
            guild.id, member.id, str(member), action,
            detail=f"3-level warning system (warning #{count})")

        # 4) optionally reset the count so a returning member starts fresh
        if ok and ws.get("reset_after_action", 1):
            await self.bot.db.execute(
                "DELETE FROM warnings WHERE guild_id = ? AND user_id = ?",
                (guild.id, member.id))

        # 5) Telegram report
        await self._telegram(guild, member.id, "warn_level3",
                             reports.final_action({
                                 "action": action,
                                 "username": str(member), "user_id": member.id,
                                 "moderator": str(interaction.user),
                                 "reason": reason,
                                 "dm": "✅" if dm_ok else "❌",
                                 "success": "✅" if ok else "❌ (permissions?)",
                                 "history": history_text,
                                 "server_name": guild.name,
                             }))
        await interaction.followup.send(
            f"🔨 **Level 3** — **{member}** was "
            f"{'**' + action + 'ned**' if action == 'ban' else '**kicked**'}"
            f"{'' if ok else ' ⚠️ **FAILED** (check bot permissions/hierarchy)'}. "
            f"DM explanation: {'✅ delivered' if dm_ok else '❌ closed'}",
            ephemeral=True)

    # ─────────────────────────────────────────────────────────
    # /warn history · /warn clear · /warn config
    # ─────────────────────────────────────────────────────────

    @app_commands.command(name="history", description="Show a member's full warning & action history")
    @app_commands.describe(member="Member to look up")
    async def history(self, interaction: discord.Interaction,
                      member: discord.Member) -> None:
        assert interaction.guild is not None
        guild = interaction.guild
        rows = await self.bot.db.fetchall(
            "SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? "
            "ORDER BY id DESC LIMIT 15", (guild.id, member.id))
        actions = await self.bot.intel_store.get_mod_actions(
            guild.id, member.id, limit=10)

        count = len(rows)
        level = min(count + 1, 3)
        embed = discord.Embed(
            title=f"📋 Warning History — {member}",
            description=(f"**Current warnings:** {count}\n"
                         f"**Next warning would be:** Level {level} "
                         f"{LEVEL_EMOJI[level]}"),
            color=discord.Color.orange(), timestamp=utcnow(),
        )
        if rows:
            embed.add_field(
                name="⚠️ Warnings",
                value="\n".join(
                    f"`#{r['id']}` {r['reason']} — "
                    f"{'<@' + str(r['moderator_id']) + '>' if r['moderator_id'] else 'auto'} "
                    f"· {str(r['created_at'])[:16]}"
                    for r in rows)[:1024],
                inline=False)
        if actions:
            embed.add_field(
                name="🔨 Moderator Actions",
                value="\n".join(
                    f"**{a['action']}** — {a.get('reason') or '—'} · "
                    f"{str(a['created_at'])[:16]}"
                    for a in actions)[:1024],
                inline=False)
        embed.set_thumbnail(url=member.display_avatar.url)
        embed.set_footer(text="All history persists across bot restarts")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="clear", description="Clear all warnings for a member")
    @app_commands.describe(member="Member whose warnings to clear")
    async def clear(self, interaction: discord.Interaction,
                    member: discord.Member) -> None:
        assert interaction.guild is not None
        guild = interaction.guild
        count = await self.bot.security_store.warning_count(guild.id, member.id)
        await self.bot.db.execute(
            "DELETE FROM warnings WHERE guild_id = ? AND user_id = ?",
            (guild.id, member.id))
        await self.bot.intel_store.add_mod_action(
            guild_id=guild.id, user_id=member.id, username=str(member),
            action="clear", level=None,
            reason=f"cleared {count} warning(s)",
            moderator_id=interaction.user.id,
            moderator_tag=str(interaction.user), dm_delivered=None,
        )
        await interaction.response.send_message(
            f"✅ Cleared **{count}** warning(s) for **{member}** — "
            f"their next warning will be Level 1 💬.", ephemeral=True)

    @app_commands.command(name="config", description="Configure the 3-level warning system")
    @app_commands.describe(
        level3_action="What happens at Level 3 (kick or ban)",
        dm_on_warn="DM the member on each warning?",
        reset_after_action="Reset warning count after kick/ban?",
    )
    async def config(
        self, interaction: discord.Interaction,
        level3_action: Literal["kick", "ban"] | None = None,
        dm_on_warn: bool | None = None,
        reset_after_action: bool | None = None,
    ) -> None:
        assert interaction.guild is not None
        gid = interaction.guild.id
        intel = self.bot.intel_store
        if level3_action is not None:
            await intel.update_warning_setting(gid, "level3_action", level3_action)
        if dm_on_warn is not None:
            await intel.update_warning_setting(gid, "dm_on_warn", int(dm_on_warn))
        if reset_after_action is not None:
            await intel.update_warning_setting(
                gid, "reset_after_action", int(reset_after_action))
        ws = await intel.get_warning_settings(gid)
        await interaction.response.send_message(
            "🛡 **3-Level Warning System**\n"
            f"• Level 1 💬 friendly reminder → no punishment\n"
            f"• Level 2 ⚠️ official warning → stored permanently\n"
            f"• Level 3 🔨 final action → **{ws.get('level3_action', 'kick')}**\n"
            f"• DM on warn: {'🟢' if ws.get('dm_on_warn', 1) else '🔴'} · "
            f"Reset after removal: "
            f"{'🟢' if ws.get('reset_after_action', 1) else '🔴'}",
            ephemeral=True)


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(WarningSystem(bot))
