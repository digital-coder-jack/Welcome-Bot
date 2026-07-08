"""
Three-Level Warning System cog — /warn slash-command group (v2.0).

Level 1 → friendly reminder (no punishment) — explains rule, what happened,
          and how to avoid repeating it.
Level 2 → official warning (permanently stored) — references the previous
          reminder and states possible next consequences.
Level 3 → MODERATOR REVIEW. The bot NEVER kicks or bans automatically:
          a premium Security Alert embed with full evidence, warning
          history and violation timeline is posted to #security-alerts.
          Only Administrators / the Security Team role can approve
          Final Warning / Timeout / Kick / Ban / Dismiss via buttons.

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
DEFAULT_L3_NOTICE = (
    "🚨 You have received your **third warning** in **{server}**.\n\n"
    "**Reason:** {reason}\n\n"
    "Your case has been sent to the moderation team for review. "
    "A moderator will decide the outcome — please follow the Forge "
    "Protocol in the meantime."
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
        lang = await self.bot.guardian_store.language(guild.id)
        t = self.bot.i18n.t
        msg = ws.get("level1_message") or DEFAULT_L1
        embed = discord.Embed(
            title=t(lang, "warn.l1.title", server=guild.name),
            description=msg,
            color=discord.Color.blue(), timestamp=utcnow(),
        )
        embed.add_field(name=t(lang, "warn.rule"),
                        value="Forge Protocol — see the server rules channel.",
                        inline=False)
        embed.add_field(name=t(lang, "warn.what"), value=reason[:1024], inline=False)
        embed.add_field(
            name=t(lang, "warn.avoid"),
            value="Please review the rules and adjust the behaviour described "
                  "above — this reminder carries **no punishment**. 😊",
            inline=False)
        embed.set_footer(text=t(lang, "warn.l1.footer"))
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
        lang = await self.bot.guardian_store.language(guild.id)
        t = self.bot.i18n.t
        msg = ws.get("level2_message") or DEFAULT_L2
        embed = discord.Embed(
            title=t(lang, "warn.l2.title", server=guild.name),
            description=msg,
            color=discord.Color.orange(), timestamp=utcnow(),
        )
        embed.add_field(name=t(lang, "warn.what"), value=reason[:1024], inline=False)
        embed.add_field(name=t(lang, "warn.previous"),
                        value=self._history_text(history[:-1])[:1024],
                        inline=False)
        embed.add_field(name=t(lang, "warn.next"),
                        value=t(lang, "warn.l2.next"), inline=False)
        embed.set_footer(text=t(lang, "warn.l2.footer"))
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
        """Level 3 — MODERATOR REVIEW. The bot never kicks/bans by itself:
        it collects evidence, builds a violation timeline and opens a
        pending review in #security-alerts. Authorized moderators approve
        Final Warning / Timeout / Kick / Ban / Dismiss via buttons."""
        guild = interaction.guild
        recommended = (ws.get("level3_action") or "kick").lower()
        if recommended not in ("kick", "ban"):
            recommended = "kick"
        history_text = self._history_text(history)

        # 1) build evidence + violation timeline from the audit trail
        evidence = [
            f"Warning #{i}: {w.get('reason', '—')} "
            f"({(w.get('created_at') or '')[:16].replace('T', ' ')})"
            for i, w in enumerate(history, 1)
        ]
        evidence.append(f"Current violation: {reason}")
        timeline = [
            {"at": w.get("created_at") or "", "what": w.get("reason", "—")}
            for w in history
        ]
        events = await self.bot.security_store.recent_events(
            guild.id, limit=25)
        for ev in events:
            if ev.get("user_id") == member.id:
                evidence.append(
                    f"Security event [{ev['event_type']}]: "
                    f"{(ev.get('evidence') or '—')[:150]}")
                timeline.append({"at": ev.get("created_at") or "",
                                 "what": f"{ev['event_type']} — "
                                         f"{ev.get('action_taken') or 'logged'}"})
        timeline.sort(key=lambda x: x.get("at") or "")

        # confidence: 3+ recorded warnings with clear reasons ⇒ high
        confidence = "high" if count >= 3 else "medium"

        # 2) open the moderator review (duplicate-safe)
        review_id = await self.bot.review_manager.open_review(
            member, source="warn_l3",
            violation=f"Third warning reached — Forge Protocol violation: {reason}",
            recommended_action=recommended, confidence=confidence,
            evidence=evidence[:15], history=history, timeline=timeline[:20],
        )

        # 3) notify the member that their case went to review (no punishment yet)
        dm_ok = False
        if review_id is not None and ws.get("dm_on_warn", 1):
            embed = discord.Embed(
                title=f"🚨 Moderation Review — {guild.name}",
                description=DEFAULT_L3_NOTICE.format(
                    server=guild.name, reason=reason),
                color=discord.Color.red(), timestamp=utcnow(),
            )
            lang = await self.bot.guardian_store.language(guild.id)
            embed.set_footer(text=self.bot.i18n.t(lang, "warn.l3.footer"))
            dm_ok = await self._dm(member, "", embed)

        # 4) audit everything
        await self.bot.intel_store.add_mod_action(
            guild_id=guild.id, user_id=member.id, username=str(member),
            action="warn_l3_review", level=3, reason=reason,
            moderator_id=interaction.user.id, moderator_tag=str(interaction.user),
            dm_delivered=dm_ok, history=history,
        )
        await self.bot.security_store.log_event(
            guild_id=guild.id, user_id=member.id, username=str(member),
            event_type="manual",
            evidence=f"level 3 warning → moderator review "
                     f"#{review_id or 'duplicate'} | "
                     f"history={json.dumps(history)[:700]}",
            action_taken="review_opened" if review_id else "review_already_pending",
            moderator_id=interaction.user.id,
        )
        await self.bot.intel_store.add_member_event(
            guild.id, member.id, str(member), "review",
            detail=f"3rd warning → moderator review (warning #{count})")

        # 5) Telegram report
        await self._telegram(guild, member.id, "warn_level3",
                             reports.final_action({
                                 "action": f"moderator review (rec: {recommended})",
                                 "username": str(member), "user_id": member.id,
                                 "moderator": str(interaction.user),
                                 "reason": reason,
                                 "dm": "✅" if dm_ok else "❌",
                                 "success": "✅ review opened" if review_id
                                            else "ℹ️ review already pending",
                                 "history": history_text,
                                 "server_name": guild.name,
                             }))
        if review_id:
            await interaction.followup.send(
                f"🚨 **Level 3** — **{member}** has reached 3 warnings. "
                f"**No automatic punishment was applied.** A moderation review "
                f"(`#{review_id}`) with full evidence was posted to the "
                f"security-alerts channel — an authorized moderator must "
                f"approve **{recommended}** (or another action) there. "
                f"Member notified: {'✅' if dm_ok else '❌'}",
                ephemeral=True)
        else:
            await interaction.followup.send(
                f"ℹ️ **{member}** already has a pending moderation review — "
                f"no duplicate alert was created. The new warning was recorded "
                f"({count} total).",
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
            "🛡 **3-Level Warning System (Forge Guardian)**\n"
            f"• Level 1 💬 friendly reminder → no punishment\n"
            f"• Level 2 ⚠️ official warning → stored permanently\n"
            f"• Level 3 🚨 **moderator review** → recommended action: "
            f"**{ws.get('level3_action', 'kick')}** (never automatic — "
            f"an authorized moderator must approve via buttons)\n"
            f"• DM on warn: {'🟢' if ws.get('dm_on_warn', 1) else '🔴'} · "
            f"Reset after removal: "
            f"{'🟢' if ws.get('reset_after_action', 1) else '🔴'}",
            ephemeral=True)


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(WarningSystem(bot))
