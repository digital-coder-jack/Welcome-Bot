"""
Premium Welcome DM builder (v2.0) — a professional multi-embed onboarding
experience with animated GIF banner, server logo, buttons and rich sections.

Discord embed limitations handled honestly:
  • Uploaded MP4s cannot autoplay inside embeds → we use high-quality
    animated GIF banners instead (fully supported via embed.set_image).
  • Up to 10 embeds per message; we use 4 focused ones.
  • Buttons in DMs must be link-style (no interaction handler needed).

RESPONSIVE DESIGN (single layout, all devices):
  Discord embeds are natively fluid — the client resizes the embed to the
  viewport (320 px phones → 1920 px desktops, portrait & landscape, any
  DPI) — so responsiveness is achieved by never fighting that fluidity:
    • Prose is written as flowing paragraphs (no manual desktop-tuned
      line breaks) so text auto-wraps at every width and never overflows.
    • Banner GIFs use set_image, which scales proportionally to the embed
      width and reserves its box while loading → no layout shift, no
      overlap, banner always stays at the top of the visual hierarchy.
    • Buttons are laid out at most MAX_BUTTONS_PER_ROW per action row in
      BALANCED rows (5 → 3+2, 4 → 2+2). Five labelled buttons in one row
      shrink below the 44×44 px minimum touch target on small phones;
      balanced rows keep every button fully labelled and easily tappable
      on 320–414 px screens while staying tidy on desktop.
  Verified by onboarding/tests/test_dm_responsive.py.
"""
from __future__ import annotations

from typing import Any

import discord

from bot.utils.formatting import discord_ts, utcnow

# High-quality animated welcome GIF banners (hot-swappable per guild via the
# welcome_settings.dm_banner_url column; these are the curated defaults).
DEFAULT_BANNER_GIF = "https://media.giphy.com/media/L8K62iTDkzGX6/giphy.gif"
COMMUNITY_GIF = "https://media.giphy.com/media/3oKIPnAiaMCws8nOsE/giphy.gif"

# theme colours per section
C_WELCOME = 0x5865F2   # blurple
C_START = 0x57F287     # green
C_RULES = 0xFEE75C     # yellow
C_COMMUNITY = 0xEB459E # fuchsia

# Max buttons per action row — responsive touch-target cap (see module doc).
MAX_BUTTONS_PER_ROW = 3


def balanced_row_sizes(count: int) -> list[int]:
    """Split ``count`` buttons into balanced row sizes.

    Balancing (5 → [3, 2], 4 → [2, 2]) instead of greedy filling
    (4 → [3, 1]) keeps rows visually even so spacing stays consistent
    and no button looks orphaned at any viewport width.
    """
    if count <= 0:
        return []
    rows = -(-count // MAX_BUTTONS_PER_ROW)  # ceil division
    base, remainder = divmod(count, rows)
    return [base + (1 if r < remainder else 0) for r in range(rows)]


def _ch(cid: int | None, fallback: str) -> str:
    return f"<#{cid}>" if cid else fallback


def build_premium_dm_embeds(
    member: discord.Member,
    settings: dict[str, Any],
    welcome_settings: dict[str, Any],
    default_footer: str,
) -> list[discord.Embed]:
    """Four themed embeds: Welcome → Start Here → Rules → Community."""
    guild = member.guild
    branding = settings.get("branding") or "Developer Forge"
    footer = settings.get("embed_footer") or default_footer
    logo = settings.get("server_logo_url") or (
        guild.icon.url if guild.icon else None)
    banner = welcome_settings.get("dm_banner_url") or DEFAULT_BANNER_GIF

    rules = settings.get("rules_channel_id")
    dev_intro = settings.get("dev_intro_channel_id")
    chill = settings.get("chill_zone_channel_id")
    tech_news = settings.get("tech_news_channel_id")

    # ── 1. 👋 Welcome (hero embed with animated GIF banner) ──
    hero = discord.Embed(
        title=f"👋 Welcome to {guild.name}!",
        description=(
            f"Hey {member.mention} — **we're thrilled to have you!** 🎉\n\n"
            f"You just joined **{branding}**, a community of developers, "
            f"builders and AI enthusiasts who ship real things together.\n\n"
            f"🗓 Joined {discord_ts(utcnow(), 'F')}\n"
            f"👥 You're member **#{guild.member_count}**"
        ),
        color=C_WELCOME,
        timestamp=utcnow(),
    )
    if logo:
        hero.set_author(name=branding, icon_url=logo)
        hero.set_thumbnail(url=logo)
    else:
        hero.set_author(name=branding)
    hero.set_image(url=banner)  # animated GIF — autoplays in Discord

    # ── 2. 🚀 Start Here ─────────────────────────────────────
    custom = welcome_settings.get("dm_message")
    start = discord.Embed(
        title="🚀 Start Here — 3 quick steps",
        # Sub-lines use blockquote markup ("> ") instead of leading spaces:
        # Discord preserves the quote bar at every viewport width, so
        # wrapped continuation text stays visually attached to its step on
        # narrow phones instead of turning into ragged floating lines.
        description=custom or (
            f"**1.** 📜 Read the rules → {_ch(rules, '#rules')}\n"
            f"**2.** 💻 Introduce yourself → {_ch(dev_intro, '#dev-intro')}\n"
            f"> Tell us what you build — languages, frameworks, projects!\n"
            f"**3.** 🎉 Say hi in {_ch(chill, '#chill-zone')}\n"
            f"> Your **first message** there unlocks the 🔥 "
            f"**Forge Member** role!"
        ),
        color=C_START,
    )
    start.set_thumbnail(url=member.display_avatar.url)

    # ── 3. 📜 Rules snapshot ─────────────────────────────────
    rules_embed = discord.Embed(
        title="📜 Community Rules (the short version)",
        description=(
            "**1.** Be respectful — no harassment, hate speech or personal attacks\n"
            "**2.** No spam, scams or unsolicited advertising\n"
            "**3.** Keep content in the right channels\n"
            "**4.** No NSFW content\n"
            "**5.** Follow Discord's Terms of Service\n\n"
            f"📖 Full rules: {_ch(rules, '#rules')}"
        ),
        color=C_RULES,
    )

    # ── 4. 🎉 Community & Links ──────────────────────────────
    community = discord.Embed(
        title="🎉 Your Community Awaits",
        description=(
            "**⭐ Useful places:**\n"
            f"💻 Developer intros → {_ch(dev_intro, '#dev-intro')}\n"
            f"💬 Chill Zone → {_ch(chill, '#chill-zone')}\n"
            f"📰 Tech News → {_ch(tech_news, '#tech-news')}\n\n"
            "**Need help?** Ping a moderator or use the **Support** button "
            "below — we're friendly, promise. 😄\n\n"
            f"**Welcome aboard, {member.display_name} — "
            f"we can't wait to see what you build!** ⚡💙"
        ),
        color=C_COMMUNITY,
    )
    community.set_image(url=COMMUNITY_GIF)
    community.set_footer(
        text=footer, icon_url=logo if logo else None)

    return [hero, start, rules_embed, community]


def build_premium_dm_view(
    member: discord.Member, settings: dict[str, Any]
) -> discord.ui.View | None:
    """Link buttons: Rules · Community Guide · Support · Invite Friends · Website.

    Buttons are placed on explicit, BALANCED rows (max MAX_BUTTONS_PER_ROW
    per row) so every button keeps a comfortable ≥ 44×44 px touch target on
    phones instead of letting discord.py greedily pack 5 into one row.
    """
    guild = member.guild
    view = discord.ui.View(timeout=None)

    def url_for(channel_id: int | None) -> str | None:
        return (f"https://discord.com/channels/{guild.id}/{channel_id}"
                if channel_id else None)

    candidates: list[tuple[str, str | None]] = [
        ("📜 Rules", url_for(settings.get("rules_channel_id"))),
        ("📖 Community Guide", url_for(settings.get("dev_intro_channel_id"))),
        ("💬 Chill Zone", url_for(settings.get("chill_zone_channel_id"))),
        ("🆘 Support", url_for(settings.get("welcome_channel_id"))),
    ]

    # invite friends — vanity URL if the guild has one, else main guild link
    if guild.vanity_url_code:
        candidates.append(
            ("🤝 Invite Friends", f"https://discord.gg/{guild.vanity_url_code}"))

    website = settings.get("website_url")
    if website:
        candidates.append(("🌐 Website", website))

    active = [(label, url) for label, url in candidates if url]
    if not active:
        return None

    # Assign each button an explicit balanced row index.
    row_index, used_in_row = 0, 0
    sizes = balanced_row_sizes(len(active))
    for label, url in active:
        if used_in_row >= sizes[row_index]:
            row_index += 1
            used_in_row = 0
        view.add_item(discord.ui.Button(
            label=label, style=discord.ButtonStyle.link, url=url,
            row=row_index))
        used_in_row += 1

    return view
