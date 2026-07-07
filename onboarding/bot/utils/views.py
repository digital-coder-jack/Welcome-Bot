"""Interactive welcome buttons (fully configurable per guild)."""
from __future__ import annotations

from typing import Any

import discord

DEFAULT_LABELS: dict[str, str] = {
    "rules": "📖 Rules",
    "dev_intro": "👋 Dev Intro",
    "chill_zone": "💬 Chill Zone",
    "tech_news": "📰 Tech News",
    "website": "🌐 Website",
}


def _channel_url(guild_id: int, channel_id: int) -> str:
    return f"https://discord.com/channels/{guild_id}/{channel_id}"


def build_welcome_view(guild_id: int, settings: dict[str, Any]) -> discord.ui.View | None:
    """
    Build the welcome button row from guild settings.
    Every button label is configurable via `button_labels`; buttons whose
    target channel/URL is not configured are omitted automatically.
    """
    labels = {**DEFAULT_LABELS, **(settings.get("button_labels") or {})}
    view = discord.ui.View(timeout=None)
    added = False

    channel_buttons = (
        ("rules", settings.get("rules_channel_id")),
        ("dev_intro", settings.get("dev_intro_channel_id")),
        ("chill_zone", settings.get("chill_zone_channel_id")),
        ("tech_news", settings.get("tech_news_channel_id")),
    )
    for key, channel_id in channel_buttons:
        if channel_id:
            view.add_item(discord.ui.Button(
                label=labels[key],
                style=discord.ButtonStyle.link,
                url=_channel_url(guild_id, int(channel_id)),
            ))
            added = True

    website = settings.get("website_url")
    if website:
        view.add_item(discord.ui.Button(
            label=labels["website"],
            style=discord.ButtonStyle.link,
            url=website,
        ))
        added = True

    return view if added else None
