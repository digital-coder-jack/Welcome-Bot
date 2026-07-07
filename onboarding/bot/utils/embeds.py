"""Premium embed builders — clean blue Developer Forge theme."""
from __future__ import annotations

from typing import Any

import discord

from bot.utils.formatting import discord_ts, human_age, ordinal, utcnow

DEFAULT_COLOR = 0x2E86DE


def _color(settings: dict[str, Any], fallback: int = DEFAULT_COLOR) -> discord.Color:
    return discord.Color(int(settings.get("embed_color") or fallback))


def _footer(settings: dict[str, Any], fallback: str) -> str:
    return settings.get("embed_footer") or fallback


def build_welcome_embed(
    member: discord.Member,
    *,
    member_number: int,
    inviter_name: str | None,
    invite_code: str | None,
    settings: dict[str, Any],
    default_footer: str,
) -> discord.Embed:
    """The public welcome embed — friendly, premium, no sensitive data."""
    guild = member.guild
    branding = settings.get("branding") or "Developer Forge"

    embed = discord.Embed(
        title=f"⚡ Welcome to {guild.name}!",
        description=(
            f"Hey {member.mention}, welcome aboard! 🎉\n"
            f"You are our **{ordinal(member_number)}** member.\n\n"
            f"Explore the buttons below to get started. 🚀"
        ),
        color=_color(settings),
        timestamp=utcnow(),
    )
    embed.set_thumbnail(url=member.display_avatar.url)
    if guild.icon:
        embed.set_author(name=branding, icon_url=guild.icon.url)
    else:
        embed.set_author(name=branding)

    embed.add_field(name="👤 Username", value=str(member), inline=True)
    embed.add_field(name="🏷 Display Name", value=member.display_name, inline=True)
    embed.add_field(name="🔢 Member #", value=f"`#{member_number}`", inline=True)
    embed.add_field(
        name="📅 Account Created",
        value=discord_ts(member.created_at, "D"),
        inline=True,
    )
    embed.add_field(name="⌛ Account Age", value=human_age(member.created_at), inline=True)
    embed.add_field(name="👥 Members", value=f"`{guild.member_count}`", inline=True)

    if inviter_name:
        invite_value = f"{inviter_name}"
        if invite_code:
            invite_value += f" · `{invite_code}`"
        embed.add_field(name="📨 Invited By", value=invite_value, inline=True)

    embed.set_footer(
        text=_footer(settings, default_footer),
        icon_url=guild.icon.url if guild.icon else None,
    )
    return embed


def build_welcome_dm_embed(
    member: discord.Member,
    settings: dict[str, Any],
    welcome_settings: dict[str, Any],
    default_footer: str,
) -> discord.Embed:
    guild = member.guild
    branding = settings.get("branding") or "Developer Forge"

    rules = settings.get("rules_channel_id")
    dev_intro = settings.get("dev_intro_channel_id")
    chill = settings.get("chill_zone_channel_id")

    def ch(cid: int | None, fallback: str) -> str:
        return f"<#{cid}>" if cid else fallback

    custom = welcome_settings.get("dm_message")
    description = custom or (
        f"Welcome to **{guild.name}** — we're thrilled to have you! 🎉\n\n"
        f"**{branding}** is a community of developers, builders and AI "
        f"enthusiasts sharing knowledge, projects and the latest in tech.\n\n"
        f"**Getting started:**\n"
        f"📖 Read the rules in {ch(rules, '#rules')}\n"
        f"👋 Introduce yourself in {ch(dev_intro, '#dev-intro')}\n"
        f"💬 Say hi in {ch(chill, '#chill-zone')}\n\n"
        f"🤖 Love **AI & Programming**? You're in the right place — we host "
        f"deep discussions, code reviews and project showcases every week.\n\n"
        f"See you inside — happy building! ⚡"
    )

    embed = discord.Embed(
        title=f"👋 Welcome to {guild.name}!",
        description=description,
        color=_color(settings),
        timestamp=utcnow(),
    )
    embed.set_thumbnail(url=guild.icon.url if guild.icon else member.display_avatar.url)
    embed.set_footer(text=_footer(settings, default_footer))
    return embed


def build_forge_dm_embed(
    member: discord.Member,
    settings: dict[str, Any],
    default_footer: str,
) -> discord.Embed:
    guild = member.guild
    embed = discord.Embed(
        title="🔥 Forge Member Unlocked!",
        description=(
            f"Congratulations {member.display_name} — you just earned the "
            f"**🔥 Forge Member** role in **{guild.name}**!\n\n"
            f"We love seeing active members like you. Here's what you can do next:\n\n"
            f"🛠 **Share your projects** — show us what you're building\n"
            f"💬 **Join discussions** — your voice matters\n"
            f"🤖 **Talk about AI** — models, agents, prompts, all of it\n"
            f"📰 **Read Tech News** — stay ahead of the curve\n"
            f"🎉 **Participate in future events** — hackathons & showcases\n\n"
            f"Thanks for making the community better. Keep forging! ⚡"
        ),
        color=_color(settings),
        timestamp=utcnow(),
    )
    embed.set_thumbnail(url=guild.icon.url if guild.icon else member.display_avatar.url)
    embed.set_footer(text=_footer(settings, default_footer))
    return embed
