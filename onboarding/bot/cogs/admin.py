"""
Admin dashboard cog — /forge slash-command group.

Lets administrators configure every aspect of the onboarding system:
feature toggles, channels, roles, branding, button labels and embed style.
All values persist in the database per guild.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Literal

import discord
from discord import app_commands
from discord.ext import commands

from bot.core.logging import get_logger
from bot.utils.views import DEFAULT_LABELS

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("cogs.admin")

FeatureName = Literal[
    "welcome", "welcome_image", "welcome_dm", "telegram",
    "invite_tracking", "activity_unlock", "auto_role", "remove_new_member_role",
]
_FEATURE_COLUMNS: dict[str, str] = {
    "welcome": "enable_welcome",
    "welcome_image": "enable_welcome_image",
    "welcome_dm": "enable_welcome_dm",
    "telegram": "enable_telegram",
    "invite_tracking": "enable_invite_tracking",
    "activity_unlock": "enable_activity_unlock",
    "auto_role": "enable_auto_role",
    "remove_new_member_role": "remove_new_member_role",
}

ChannelName = Literal["welcome", "rules", "dev_intro", "chill_zone", "tech_news"]
_CHANNEL_COLUMNS: dict[str, str] = {
    "welcome": "welcome_channel_id",
    "rules": "rules_channel_id",
    "dev_intro": "dev_intro_channel_id",
    "chill_zone": "chill_zone_channel_id",
    "tech_news": "tech_news_channel_id",
}

RoleName = Literal["new_member", "forge_member"]
_ROLE_COLUMNS: dict[str, str] = {
    "new_member": "new_member_role_id",
    "forge_member": "forge_member_role_id",
}

ButtonKey = Literal["rules", "dev_intro", "chill_zone", "tech_news", "website"]


@app_commands.default_permissions(administrator=True)
@app_commands.guild_only()
class ForgeConfig(commands.GroupCog, group_name="forge"):
    """Configuration dashboard for the Developer Forge onboarding system."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot

    # ── feature toggles ──────────────────────────────────────

    @app_commands.command(name="toggle", description="Enable or disable an onboarding feature")
    @app_commands.describe(feature="Feature to toggle", enabled="Turn the feature on/off")
    async def toggle(
        self, interaction: discord.Interaction,
        feature: FeatureName, enabled: bool,
    ) -> None:
        assert interaction.guild is not None
        await self.bot.db.update_guild_setting(
            interaction.guild.id, _FEATURE_COLUMNS[feature], int(enabled)
        )
        await interaction.response.send_message(
            f"✅ **{feature.replace('_', ' ').title()}** is now "
            f"{'**enabled** 🟢' if enabled else '**disabled** 🔴'}.",
            ephemeral=True,
        )

    # ── channels ─────────────────────────────────────────────

    @app_commands.command(name="channel", description="Set a configured channel")
    @app_commands.describe(target="Which channel setting", channel="The text channel")
    async def channel(
        self, interaction: discord.Interaction,
        target: ChannelName, channel: discord.TextChannel,
    ) -> None:
        assert interaction.guild is not None
        await self.bot.db.update_guild_setting(
            interaction.guild.id, _CHANNEL_COLUMNS[target], channel.id
        )
        await interaction.response.send_message(
            f"✅ **{target.replace('_', ' ').title()}** channel set to {channel.mention}.",
            ephemeral=True,
        )

    # ── roles ────────────────────────────────────────────────

    @app_commands.command(name="role", description="Set an onboarding role")
    @app_commands.describe(target="Which role setting", role="The role to use")
    async def role(
        self, interaction: discord.Interaction,
        target: RoleName, role: discord.Role,
    ) -> None:
        assert interaction.guild is not None
        me = interaction.guild.me
        if me and role >= me.top_role:
            await interaction.response.send_message(
                "⚠️ That role is above my highest role — I won't be able to "
                "assign it. Please move my role higher or choose another role.",
                ephemeral=True,
            )
            return
        await self.bot.db.update_guild_setting(
            interaction.guild.id, _ROLE_COLUMNS[target], role.id
        )
        await interaction.response.send_message(
            f"✅ **{target.replace('_', ' ').title()}** role set to {role.mention}.",
            ephemeral=True,
        )

    # ── branding & style ─────────────────────────────────────

    @app_commands.command(name="branding", description="Set branding, footer, website, logo or embed color")
    @app_commands.describe(
        website_url="Website URL for the 🌐 button",
        embed_color="Hex color like #2E86DE",
        footer="Embed footer text",
        branding="Brand name shown on embeds & images",
        server_logo_url="Logo image URL for the welcome card",
        unlock_reaction="Emoji reaction for first message (e.g. 🔥 or 🚀)",
    )
    async def branding(
        self,
        interaction: discord.Interaction,
        website_url: str | None = None,
        embed_color: str | None = None,
        footer: str | None = None,
        branding: str | None = None,
        server_logo_url: str | None = None,
        unlock_reaction: str | None = None,
    ) -> None:
        assert interaction.guild is not None
        gid = interaction.guild.id
        changes: list[str] = []

        if website_url is not None:
            if not website_url.startswith(("http://", "https://")):
                await interaction.response.send_message(
                    "⚠️ Website URL must start with http(s)://", ephemeral=True)
                return
            await self.bot.db.update_guild_setting(gid, "website_url", website_url)
            changes.append("website")
        if embed_color is not None:
            try:
                color = int(embed_color.lstrip("#"), 16)
            except ValueError:
                await interaction.response.send_message(
                    "⚠️ Invalid hex color. Example: `#2E86DE`", ephemeral=True)
                return
            await self.bot.db.update_guild_setting(gid, "embed_color", color)
            changes.append("embed color")
        if footer is not None:
            await self.bot.db.update_guild_setting(gid, "embed_footer", footer)
            changes.append("footer")
        if branding is not None:
            await self.bot.db.update_guild_setting(gid, "branding", branding)
            changes.append("branding")
        if server_logo_url is not None:
            await self.bot.db.update_guild_setting(gid, "server_logo_url", server_logo_url)
            changes.append("server logo")
        if unlock_reaction is not None:
            await self.bot.db.update_guild_setting(gid, "unlock_reaction", unlock_reaction)
            changes.append("unlock reaction")

        if not changes:
            await interaction.response.send_message(
                "ℹ️ Nothing to update — provide at least one option.", ephemeral=True)
            return
        await interaction.response.send_message(
            f"✅ Updated: **{', '.join(changes)}**.", ephemeral=True)

    # ── button labels ────────────────────────────────────────

    @app_commands.command(name="button", description="Customize a welcome button label")
    @app_commands.describe(button="Which button", label="New label (emoji + text)")
    async def button(
        self, interaction: discord.Interaction,
        button: ButtonKey, label: str,
    ) -> None:
        assert interaction.guild is not None
        if len(label) > 80:
            await interaction.response.send_message(
                "⚠️ Button labels must be 80 characters or fewer.", ephemeral=True)
            return
        settings = await self.bot.db.get_guild_settings(interaction.guild.id)
        labels: dict = settings.get("button_labels") or {}
        labels[button] = label
        await self.bot.db.update_guild_setting(
            interaction.guild.id, "button_labels_json", json.dumps(labels)
        )
        await interaction.response.send_message(
            f"✅ **{button.replace('_', ' ').title()}** button label set to `{label}`.",
            ephemeral=True,
        )

    # ── DM / welcome text customization ──────────────────────

    @app_commands.command(name="messages", description="Customize welcome/DM message text")
    @app_commands.describe(
        dm_message="Custom welcome DM body (leave empty to keep)",
        welcome_message="Custom public welcome text (leave empty to keep)",
    )
    async def messages(
        self,
        interaction: discord.Interaction,
        dm_message: str | None = None,
        welcome_message: str | None = None,
    ) -> None:
        assert interaction.guild is not None
        gid = interaction.guild.id
        changes: list[str] = []
        if dm_message is not None:
            await self.bot.db.update_welcome_setting(gid, "dm_message", dm_message)
            changes.append("DM message")
        if welcome_message is not None:
            await self.bot.db.update_welcome_setting(gid, "welcome_message", welcome_message)
            changes.append("welcome message")
        if not changes:
            await interaction.response.send_message(
                "ℹ️ Nothing to update.", ephemeral=True)
            return
        await interaction.response.send_message(
            f"✅ Updated: **{', '.join(changes)}**.", ephemeral=True)

    # ── overview dashboard ───────────────────────────────────

    @app_commands.command(name="settings", description="Show the current onboarding configuration")
    async def settings(self, interaction: discord.Interaction) -> None:
        assert interaction.guild is not None
        s = await self.bot.db.get_guild_settings(interaction.guild.id)

        def onoff(key: str) -> str:
            return "🟢 On" if s.get(key, 1) else "🔴 Off"

        def ch(key: str) -> str:
            cid = s.get(key)
            return f"<#{cid}>" if cid else "—"

        def rl(key: str) -> str:
            rid = s.get(key)
            return f"<@&{rid}>" if rid else "—"

        labels = {**DEFAULT_LABELS, **(s.get("button_labels") or {})}
        color = int(s.get("embed_color") or self.bot.config.defaults.embed_color)

        embed = discord.Embed(
            title="⚙️ Developer Forge — Onboarding Settings",
            color=discord.Color(color),
        )
        embed.add_field(
            name="Features",
            value=(
                f"Welcome: {onoff('enable_welcome')}\n"
                f"Welcome Image: {onoff('enable_welcome_image')}\n"
                f"Welcome DM: {onoff('enable_welcome_dm')}\n"
                f"Telegram: {onoff('enable_telegram')}\n"
                f"Invite Tracking: {onoff('enable_invite_tracking')}\n"
                f"Activity Unlock: {onoff('enable_activity_unlock')}\n"
                f"Auto Role: {onoff('enable_auto_role')}\n"
                f"Remove New Member on unlock: {onoff('remove_new_member_role')}"
            ),
            inline=False,
        )
        embed.add_field(
            name="Channels",
            value=(
                f"Welcome: {ch('welcome_channel_id')}\n"
                f"Rules: {ch('rules_channel_id')}\n"
                f"Dev Intro: {ch('dev_intro_channel_id')}\n"
                f"Chill Zone: {ch('chill_zone_channel_id')}\n"
                f"Tech News: {ch('tech_news_channel_id')}"
            ),
            inline=True,
        )
        embed.add_field(
            name="Roles",
            value=(
                f"👤 New Member: {rl('new_member_role_id')}\n"
                f"🔥 Forge Member: {rl('forge_member_role_id')}"
            ),
            inline=True,
        )
        embed.add_field(
            name="Branding",
            value=(
                f"Brand: `{s.get('branding') or self.bot.config.defaults.branding}`\n"
                f"Website: {s.get('website_url') or '—'}\n"
                f"Color: `#{color:06X}`\n"
                f"Reaction: {s.get('unlock_reaction') or self.bot.config.defaults.unlock_reaction}\n"
                f"Footer: `{(s.get('embed_footer') or self.bot.config.defaults.footer)[:60]}`"
            ),
            inline=False,
        )
        embed.add_field(
            name="Button Labels",
            value=" · ".join(f"`{v}`" for v in labels.values()),
            inline=False,
        )
        embed.set_footer(text="Use /forge toggle · channel · role · branding · button · messages")
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(ForgeConfig(bot))
