"""
Security dashboard cog — /security slash-command group.

Administrators configure every security feature at runtime: toggles,
thresholds, punishments, whitelists, ignore lists — persisted per guild.
Also exposes moderation utilities (warnings, recent events, raid controls).
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Literal

import discord
from discord import app_commands
from discord.ext import commands

from bot.core.logging import get_logger
from bot.services.security.actions import VALID_PUNISHMENTS

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("cogs.security_admin")

FeatureName = Literal[
    "security", "ai_moderation", "spam_filter", "scam_detection",
    "raid_detection", "invite_protection", "badword_filter", "mention_filter",
    "duplicate_filter", "username_check", "telegram_alerts", "raid_auto_lockdown",
]
_FEATURE_COLUMNS: dict[str, str] = {
    "security": "enable_security",
    "ai_moderation": "enable_ai_moderation",
    "spam_filter": "enable_spam_filter",
    "scam_detection": "enable_scam_detection",
    "raid_detection": "enable_raid_detection",
    "invite_protection": "enable_invite_protection",
    "badword_filter": "enable_badword_filter",
    "mention_filter": "enable_mention_filter",
    "duplicate_filter": "enable_duplicate_filter",
    "username_check": "enable_username_check",
    "telegram_alerts": "enable_telegram_alerts",
    "raid_auto_lockdown": "raid_auto_lockdown",
}

ThresholdName = Literal[
    "raid_join_threshold", "raid_window_seconds", "raid_min_risk",
    "spam_message_limit", "spam_window_seconds", "duplicate_limit",
    "mention_user_limit", "mention_role_limit", "emoji_limit",
    "caps_min_length", "timeout_minutes", "high_risk_score", "medium_risk_score",
]

Category = Literal["spam", "scam", "mention", "invite", "badword", "duplicate", "ai"]
Punishment = Literal["none", "warn", "delete", "timeout", "kick", "ban"]

ListName = Literal[
    "whitelist_domains", "whitelist_invites", "bad_words",
    "allowed_roles", "ignored_channels", "ignored_roles", "ignored_users",
]
_LIST_COLUMNS: dict[str, str] = {n: f"{n}_json" for n in (
    "whitelist_domains", "whitelist_invites", "bad_words",
    "allowed_roles", "ignored_channels", "ignored_roles", "ignored_users",
)}
_ID_LISTS = {"allowed_roles", "ignored_channels", "ignored_roles", "ignored_users"}


@app_commands.default_permissions(administrator=True)
@app_commands.guild_only()
class SecurityConfig(commands.GroupCog, group_name="security"):
    """Configuration dashboard for the Security & Protection system."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot

    # ── toggles ──────────────────────────────────────────────

    @app_commands.command(name="toggle", description="Enable or disable a security feature")
    @app_commands.describe(feature="Feature to toggle", enabled="Turn on/off")
    async def toggle(
        self, interaction: discord.Interaction,
        feature: FeatureName, enabled: bool,
    ) -> None:
        assert interaction.guild is not None
        await self.bot.security_store.update_setting(
            interaction.guild.id, _FEATURE_COLUMNS[feature], int(enabled))
        if feature == "badword_filter":
            self.bot.badword_filter.invalidate(interaction.guild.id)
        await interaction.response.send_message(
            f"🛡 **{feature.replace('_', ' ').title()}** is now "
            f"{'**enabled** 🟢' if enabled else '**disabled** 🔴'}.",
            ephemeral=True,
        )

    # ── thresholds ───────────────────────────────────────────

    @app_commands.command(name="threshold", description="Set a numeric security threshold")
    @app_commands.describe(name="Which threshold", value="New value")
    async def threshold(
        self, interaction: discord.Interaction,
        name: ThresholdName, value: app_commands.Range[int, 1, 100000],
    ) -> None:
        assert interaction.guild is not None
        await self.bot.security_store.update_setting(interaction.guild.id, name, value)
        await interaction.response.send_message(
            f"🛡 **{name.replace('_', ' ').title()}** set to `{value}`.",
            ephemeral=True,
        )

    # ── punishments ──────────────────────────────────────────

    @app_commands.command(name="punishment", description="Set the punishment for a violation category")
    @app_commands.describe(category="Violation category", punishment="Action to apply")
    async def punishment(
        self, interaction: discord.Interaction,
        category: Category, punishment: Punishment,
    ) -> None:
        assert interaction.guild is not None
        if punishment not in VALID_PUNISHMENTS:
            await interaction.response.send_message("⚠️ Invalid punishment.", ephemeral=True)
            return
        await self.bot.security_store.update_setting(
            interaction.guild.id, f"punish_{category}", punishment)
        await interaction.response.send_message(
            f"🛡 **{category.title()}** violations now trigger: **{punishment}**.",
            ephemeral=True,
        )

    # ── lists (whitelists / bad words / ignores) ─────────────

    @app_commands.command(name="list", description="Add/remove items on a security list")
    @app_commands.describe(
        name="Which list",
        action="add / remove / show / clear",
        value="Item — domain, invite code, word (or regex:pattern), or ID/mention",
    )
    async def list_cmd(
        self, interaction: discord.Interaction,
        name: ListName, action: Literal["add", "remove", "show", "clear"],
        value: str | None = None,
    ) -> None:
        assert interaction.guild is not None
        gid = interaction.guild.id
        store = self.bot.security_store
        settings = await store.get_settings(gid)
        items: list = list(settings.get(name) or [])

        if action == "show":
            shown = ", ".join(f"`{i}`" for i in items[:50]) or "*empty*"
            await interaction.response.send_message(
                f"🛡 **{name.replace('_', ' ').title()}** ({len(items)}):\n{shown}",
                ephemeral=True)
            return
        if action == "clear":
            await store.update_json_list(gid, _LIST_COLUMNS[name], [])
            if name == "bad_words":
                self.bot.badword_filter.invalidate(gid)
            await interaction.response.send_message(
                f"🛡 **{name.replace('_', ' ').title()}** cleared.", ephemeral=True)
            return

        if not value:
            await interaction.response.send_message(
                "⚠️ Provide a value for add/remove.", ephemeral=True)
            return

        item: str | int = value.strip()
        if name in _ID_LISTS:
            digits = "".join(ch for ch in str(item) if ch.isdigit())
            if not digits:
                await interaction.response.send_message(
                    "⚠️ Provide a valid ID or mention.", ephemeral=True)
                return
            item = int(digits)
        elif name == "whitelist_domains":
            item = str(item).lower().removeprefix("https://").removeprefix(
                "http://").removeprefix("www.").split("/")[0]

        if action == "add":
            if item in items:
                await interaction.response.send_message(
                    "ℹ️ Already on the list.", ephemeral=True)
                return
            items.append(item)
        else:  # remove
            if item not in items:
                await interaction.response.send_message(
                    "ℹ️ Not on the list.", ephemeral=True)
                return
            items.remove(item)

        await store.update_json_list(gid, _LIST_COLUMNS[name], items)
        if name == "bad_words":
            self.bot.badword_filter.invalidate(gid)
        await interaction.response.send_message(
            f"🛡 {'Added to' if action == 'add' else 'Removed from'} "
            f"**{name.replace('_', ' ').title()}**: `{item}` ({len(items)} total).",
            ephemeral=True,
        )

    # ── raid controls ────────────────────────────────────────

    @app_commands.command(name="raidmode", description="Manually enable/disable raid mode & lockdown")
    @app_commands.describe(enabled="Enable raid lockdown?")
    async def raidmode(self, interaction: discord.Interaction, enabled: bool) -> None:
        assert interaction.guild is not None
        await interaction.response.defer(ephemeral=True)
        guild = interaction.guild
        store = self.bot.security_store

        changed = await self.bot.action_executor.lockdown_guild(guild, lock=enabled)
        await store.update_setting(guild.id, "raid_mode_active", int(enabled))
        if not enabled:
            self.bot.raid_detector.reset(guild.id)
        await store.log_event(
            guild_id=guild.id, event_type="raid",
            evidence=f"manual raid mode {'ON' if enabled else 'OFF'} — "
                     f"{len(changed)} channels {'locked' if enabled else 'unlocked'}",
            action_taken="lockdown" if enabled else "unlock",
            moderator_id=interaction.user.id,
        )
        await interaction.followup.send(
            f"🛡 Raid mode **{'ENABLED — channels locked' if enabled else 'disabled — channels unlocked'}** "
            f"({len(changed)} channels affected).",
            ephemeral=True,
        )

    # ── moderation utilities ─────────────────────────────────

    @app_commands.command(name="warnings", description="Show a member's warning count")
    @app_commands.describe(member="Member to look up")
    async def warnings(self, interaction: discord.Interaction, member: discord.Member) -> None:
        assert interaction.guild is not None
        count = await self.bot.security_store.warning_count(
            interaction.guild.id, member.id)
        await interaction.response.send_message(
            f"⚠️ **{member}** has **{count}** warning(s).", ephemeral=True)

    @app_commands.command(name="events", description="Show recent security events")
    @app_commands.describe(event_type="Filter by type (optional)")
    async def events(
        self, interaction: discord.Interaction,
        event_type: Literal["join_risk", "raid", "spam", "scam", "mention_spam",
                            "invite", "badword", "duplicate", "username",
                            "ai_flag"] | None = None,
    ) -> None:
        assert interaction.guild is not None
        rows = await self.bot.security_store.recent_events(
            interaction.guild.id, event_type=event_type, limit=10)
        if not rows:
            await interaction.response.send_message(
                "🛡 No security events recorded yet.", ephemeral=True)
            return
        lines = []
        for r in rows:
            user = f"<@{r['user_id']}>" if r.get("user_id") else "—"
            lines.append(
                f"`#{r['id']}` **{r['event_type']}** {user} → "
                f"{r.get('action_taken') or 'logged'} · {r['created_at'][:19]}")
        embed = discord.Embed(
            title="🛡 Recent Security Events",
            description="\n".join(lines),
            color=discord.Color.red(),
        )
        embed.set_footer(text="Full details are in the database & Telegram alerts")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    # ── overview dashboard ───────────────────────────────────

    @app_commands.command(name="settings", description="Show the current security configuration")
    async def settings(self, interaction: discord.Interaction) -> None:
        assert interaction.guild is not None
        s = await self.bot.security_store.get_settings(interaction.guild.id)

        def onoff(key: str) -> str:
            return "🟢" if s.get(key) else "🔴"

        embed = discord.Embed(
            title="🛡 Developer Forge — Security Settings",
            color=discord.Color.dark_red(),
        )
        embed.add_field(
            name="Features",
            value=(
                f"{onoff('enable_security')} Security master\n"
                f"{onoff('enable_raid_detection')} Raid detection "
                f"({onoff('raid_auto_lockdown')} auto-lockdown)\n"
                f"{onoff('enable_spam_filter')} Spam filter\n"
                f"{onoff('enable_scam_detection')} Scam detection\n"
                f"{onoff('enable_invite_protection')} Invite protection\n"
                f"{onoff('enable_mention_filter')} Mention filter\n"
                f"{onoff('enable_badword_filter')} Bad word filter\n"
                f"{onoff('enable_duplicate_filter')} Duplicate filter\n"
                f"{onoff('enable_username_check')} Username check\n"
                f"{onoff('enable_ai_moderation')} AI moderation "
                f"(`{self.bot.ai_moderation.mode}`)\n"
                f"{onoff('enable_telegram_alerts')} Telegram alerts"
            ),
            inline=False,
        )
        embed.add_field(
            name="Thresholds",
            value=(
                f"Raid: `{s['raid_join_threshold']}` joins / `{s['raid_window_seconds']}`s "
                f"(min risk `{s['raid_min_risk']}`)\n"
                f"Spam: `{s['spam_message_limit']}` msgs / `{s['spam_window_seconds']}`s\n"
                f"Duplicates: `{s['duplicate_limit']}` · Emoji: `{s['emoji_limit']}`\n"
                f"Mentions: `{s['mention_user_limit']}` users / `{s['mention_role_limit']}` roles\n"
                f"Caps: `{int(float(s['caps_ratio']) * 100)}%` over `{s['caps_min_length']}` chars\n"
                f"Timeout: `{s['timeout_minutes']}`m · Risk 🔴≥`{s['high_risk_score']}` "
                f"🟡≥`{s['medium_risk_score']}`\n"
                f"AI confidence: `{float(s['ai_min_confidence']):.2f}`"
            ),
            inline=False,
        )
        embed.add_field(
            name="Punishments",
            value=" · ".join(
                f"{c}: `{s[f'punish_{c}']}`"
                for c in ("spam", "scam", "mention", "invite", "badword",
                          "duplicate", "ai")),
            inline=False,
        )
        embed.add_field(
            name="Lists",
            value=(
                f"Domains WL: `{len(s.get('whitelist_domains') or [])}` · "
                f"Invites WL: `{len(s.get('whitelist_invites') or [])}` · "
                f"Bad words: `{len(s.get('bad_words') or [])}`\n"
                f"Allowed roles: `{len(s.get('allowed_roles') or [])}` · "
                f"Ignored: `{len(s.get('ignored_channels') or [])}` ch / "
                f"`{len(s.get('ignored_roles') or [])}` roles / "
                f"`{len(s.get('ignored_users') or [])}` users"
            ),
            inline=False,
        )
        raid_active = "⚔️ **RAID MODE ACTIVE**" if s.get("raid_mode_active") else "🕊 Normal"
        embed.add_field(name="Status", value=raid_active, inline=False)
        embed.set_footer(
            text="Use /security toggle · threshold · punishment · list · raidmode")
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(SecurityConfig(bot))
