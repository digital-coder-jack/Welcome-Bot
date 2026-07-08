"""
Forge Guardian dashboard cog — /guardian slash-command group.

  /guardian setup       — configure #security-alerts, #mod-logs, Security Team role
  /guardian language    — set the server language (all embeds translate)
  /guardian reviews     — list pending moderation reviews
  /guardian analytics   — premium welcome & moderation analytics dashboard
  /guardian settings    — show the current Guardian configuration
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Literal

import discord
from discord import app_commands
from discord.ext import commands

from bot.core.logging import get_logger
from bot.services.i18n import SUPPORTED_LANGUAGES
from bot.utils.formatting import utcnow

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("cogs.guardian")


def _bar(value: int, total: int, width: int = 12) -> str:
    if total <= 0:
        return "░" * width
    filled = round(width * min(value, total) / total)
    return "█" * filled + "░" * (width - filled)


@app_commands.default_permissions(administrator=True)
@app_commands.guild_only()
class Guardian(commands.GroupCog, group_name="guardian"):
    """Forge Guardian — approval workflow, language & analytics dashboard."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot

    # ── setup ────────────────────────────────────────────────

    @app_commands.command(
        name="setup",
        description="Configure security-alerts channel, mod-logs channel and Security Team role")
    @app_commands.describe(
        security_alerts_channel="Channel where moderation-review alerts are posted",
        modlog_channel="Channel for moderation logs",
        security_team_role="Role allowed to approve moderation actions",
        notify_owner="Also DM review alerts to the server owner?",
        enable_modlog="Enable the moderation log?",
    )
    async def setup_cmd(
        self, interaction: discord.Interaction,
        security_alerts_channel: discord.TextChannel | None = None,
        modlog_channel: discord.TextChannel | None = None,
        security_team_role: discord.Role | None = None,
        notify_owner: bool | None = None,
        enable_modlog: bool | None = None,
    ) -> None:
        assert interaction.guild is not None
        gid = interaction.guild.id
        store = self.bot.guardian_store
        changed: list[str] = []
        if security_alerts_channel is not None:
            await store.update_setting(
                gid, "security_alerts_channel_id", security_alerts_channel.id)
            changed.append(f"🚨 Alerts → {security_alerts_channel.mention}")
        if modlog_channel is not None:
            await store.update_setting(gid, "modlog_channel_id", modlog_channel.id)
            changed.append(f"📋 Mod logs → {modlog_channel.mention}")
        if security_team_role is not None:
            await store.update_setting(
                gid, "security_team_role_id", security_team_role.id)
            changed.append(f"🛡 Security Team → {security_team_role.mention}")
        if notify_owner is not None:
            await store.update_setting(gid, "notify_owner", int(notify_owner))
            changed.append(f"👑 Owner DM → {'🟢' if notify_owner else '🔴'}")
        if enable_modlog is not None:
            await store.update_setting(gid, "enable_modlog", int(enable_modlog))
            changed.append(f"📋 Mod log → {'🟢' if enable_modlog else '🔴'}")
        await interaction.response.send_message(
            "🛡 **Forge Guardian updated:**\n" + "\n".join(changed)
            if changed else "ℹ️ Nothing changed — pass at least one option.",
            ephemeral=True)

    # ── language ─────────────────────────────────────────────

    @app_commands.command(name="language",
                          description="Set the server language for all Guardian messages")
    @app_commands.describe(language="Language used in welcomes, warnings, logs & alerts")
    async def language(
        self, interaction: discord.Interaction,
        language: Literal["en", "es", "fr", "de", "hi", "pt"],
    ) -> None:
        assert interaction.guild is not None
        await self.bot.guardian_store.update_setting(
            interaction.guild.id, "language", language)
        await interaction.response.send_message(
            f"🌍 Server language set to **{SUPPORTED_LANGUAGES[language]}** "
            f"(`{language}`). All welcome messages, warnings, moderation "
            f"messages, logs and embeds will now use it.",
            ephemeral=True)

    # ── pending reviews ──────────────────────────────────────

    @app_commands.command(name="reviews",
                          description="List pending moderation reviews awaiting approval")
    async def reviews(self, interaction: discord.Interaction) -> None:
        assert interaction.guild is not None
        pending = await self.bot.guardian_store.pending_reviews(
            interaction.guild.id, limit=10)
        if not pending:
            await interaction.response.send_message(
                "✅ No pending moderation reviews — all clear!", ephemeral=True)
            return
        lines = []
        for r in pending:
            link = ""
            if r.get("alert_channel_id") and r.get("alert_message_id"):
                link = (f" · [jump](https://discord.com/channels/"
                        f"{interaction.guild.id}/{r['alert_channel_id']}/"
                        f"{r['alert_message_id']})")
            lines.append(
                f"`#{r['id']}` <@{r['user_id']}> — {r.get('violation', '—')[:80]} "
                f"· rec **{r.get('recommended_action')}** "
                f"({r.get('confidence')}){link}")
        embed = discord.Embed(
            title="⏳ Pending Moderation Reviews",
            description="\n".join(lines),
            color=discord.Color.orange(), timestamp=utcnow())
        embed.set_footer(text="Approve actions via the buttons on each alert")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    # ── analytics dashboard ──────────────────────────────────

    @app_commands.command(name="analytics",
                          description="Premium welcome & moderation analytics dashboard")
    async def analytics(self, interaction: discord.Interaction) -> None:
        assert interaction.guild is not None
        guild = interaction.guild
        await interaction.response.defer(ephemeral=True)

        gstore = self.bot.guardian_store
        joins = await gstore.join_counts(guild.id)
        joined30, stayed30 = await gstore.retention(guild.id)
        retention = round(stayed30 / joined30 * 100) if joined30 else 100

        since7 = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        sec_counts = await self.bot.security_store.event_counts(guild.id, since7)
        mod_counts = await gstore.modlog_counts(guild.id, since7)

        row = await self.bot.db.fetchone(
            "SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? "
            "AND created_at >= ?", (guild.id, since7))
        warnings7 = int(row["n"]) if row else 0
        row = await self.bot.db.fetchone(
            "SELECT COUNT(*) AS n FROM activity_progress "
            "WHERE guild_id = ? AND completed = 1", (guild.id,))
        verified = int(row["n"]) if row else 0

        maxj = max(joins["monthly"], 1)
        embed = discord.Embed(
            title=f"📊 Forge Guardian Analytics — {guild.name}",
            color=discord.Color(0x2E86DE), timestamp=utcnow())
        if guild.icon:
            embed.set_thumbnail(url=guild.icon.url)
        embed.add_field(
            name="📥 Member Joins",
            value=(f"Today  `{joins['daily']:>4}` {_bar(joins['daily'], maxj)}\n"
                   f"7 days `{joins['weekly']:>4}` {_bar(joins['weekly'], maxj)}\n"
                   f"30 days `{joins['monthly']:>3}` {_bar(joins['monthly'], maxj)}"),
            inline=False)
        embed.add_field(
            name="📈 Growth & Retention",
            value=(f"👥 Members: `{guild.member_count}`\n"
                   f"🔁 30-day retention: `{retention}%` {_bar(retention, 100)}\n"
                   f"✅ Verified / activated: `{verified}`"),
            inline=False)
        sec_line = " · ".join(
            f"{k}: `{v}`" for k, v in sorted(sec_counts.items())) or "none 🎉"
        embed.add_field(name="🛡 Security Events (7d)", value=sec_line, inline=False)
        mod_line = " · ".join(
            f"{k}: `{v}`" for k, v in sorted(mod_counts.items())) or "none 🎉"
        embed.add_field(
            name="🔨 Moderation Actions (7d)",
            value=f"⚠️ Warnings: `{warnings7}`\n{mod_line}", inline=False)
        pending = await gstore.pending_reviews(guild.id, limit=99)
        embed.add_field(
            name="⏳ Pending Reviews",
            value=f"`{len(pending)}` awaiting moderator approval", inline=False)
        embed.set_footer(text="Forge Guardian • Analytics refresh in real time")
        await interaction.followup.send(embed=embed, ephemeral=True)

    # ── settings overview ────────────────────────────────────

    @app_commands.command(name="settings",
                          description="Show the current Forge Guardian configuration")
    async def settings(self, interaction: discord.Interaction) -> None:
        assert interaction.guild is not None
        gs = await self.bot.guardian_store.get_settings(interaction.guild.id)

        def ch(key: str) -> str:
            cid = gs.get(key)
            return f"<#{cid}>" if cid else "*(auto: by channel name)*"

        role_id = gs.get("security_team_role_id")
        embed = discord.Embed(
            title="🛡 Forge Guardian — Settings",
            color=discord.Color(0x2E86DE), timestamp=utcnow())
        embed.add_field(
            name="🌍 Language",
            value=f"**{SUPPORTED_LANGUAGES.get(gs.get('language') or 'en', 'English')}** "
                  f"(`{gs.get('language') or 'en'}`)",
            inline=False)
        embed.add_field(name="🚨 Security Alerts",
                        value=ch("security_alerts_channel_id"), inline=True)
        embed.add_field(name="📋 Mod Logs",
                        value=ch("modlog_channel_id"), inline=True)
        embed.add_field(
            name="🛡 Security Team",
            value=f"<@&{role_id}>" if role_id else "*Administrators only*",
            inline=True)
        embed.add_field(
            name="Toggles",
            value=(f"{'🟢' if gs.get('notify_owner', 1) else '🔴'} Owner DM on reviews\n"
                   f"{'🟢' if gs.get('enable_modlog', 1) else '🔴'} Moderation log"),
            inline=False)
        embed.add_field(
            name="🔒 Approval Guarantee",
            value=("The bot **never** kicks or bans automatically. Every removal "
                   "requires an authorized moderator to press a button on a "
                   "security alert."),
            inline=False)
        embed.set_footer(
            text="Use /guardian setup · language · reviews · analytics")
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(Guardian(bot))
