"""
Premium welcome card generator (Pillow).

Renders a high-resolution (1400x500 @2x aesthetic) tech-blue card with the
member avatar, username, server branding and member number. All heavy
drawing runs in a thread executor so the event loop never blocks.
"""
from __future__ import annotations

import asyncio
import io
from pathlib import Path

import aiohttp
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from bot.core.logging import get_logger

log = get_logger("welcome_image")

WIDTH, HEIGHT = 1400, 500
AVATAR_SIZE = 300

# Developer Forge tech-blue palette
BG_TOP = (10, 18, 38)
BG_BOTTOM = (18, 42, 92)
ACCENT = (46, 134, 222)
ACCENT_LIGHT = (94, 179, 255)
TEXT_PRIMARY = (240, 246, 255)
TEXT_SECONDARY = (150, 176, 220)

_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def _load_font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _FONT_CANDIDATES:
        if Path(path).exists() and ("Bold" in path) == bold:
            return ImageFont.truetype(path, size)
    for path in _FONT_CANDIDATES:  # fallback: any available
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def _rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, *size], radius=radius, fill=255)
    return mask


def _circle_mask(size: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size, size], fill=255)
    return mask


def _draw_background() -> Image.Image:
    """Vertical gradient + subtle circuit-grid tech pattern + glow orbs."""
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_TOP)
    draw = ImageDraw.Draw(img)

    for y in range(HEIGHT):
        t = y / HEIGHT
        color = tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        draw.line([(0, y), (WIDTH, y)], fill=color)

    # circuit grid
    grid = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grid)
    step = 70
    for x in range(0, WIDTH, step):
        gdraw.line([(x, 0), (x, HEIGHT)], fill=(*ACCENT, 14), width=1)
    for y in range(0, HEIGHT, step):
        gdraw.line([(0, y), (WIDTH, y)], fill=(*ACCENT, 14), width=1)
    for x in range(0, WIDTH, step * 2):
        for y in range(0, HEIGHT, step * 2):
            gdraw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(*ACCENT_LIGHT, 40))
    img = Image.alpha_composite(img.convert("RGBA"), grid)

    # glow orbs
    glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    gl = ImageDraw.Draw(glow)
    gl.ellipse([WIDTH - 420, -160, WIDTH + 120, 380], fill=(*ACCENT, 46))
    gl.ellipse([-180, HEIGHT - 240, 260, HEIGHT + 200], fill=(*ACCENT_LIGHT, 30))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    img = Image.alpha_composite(img, glow)

    # top & bottom accent bars
    bar = ImageDraw.Draw(img)
    bar.rectangle([0, 0, WIDTH, 6], fill=(*ACCENT, 255))
    bar.rectangle([0, HEIGHT - 6, WIDTH, HEIGHT], fill=(*ACCENT, 255))
    return img


def _render_card(
    avatar_bytes: bytes | None,
    username: str,
    server_name: str,
    member_number: int,
    branding: str,
    logo_bytes: bytes | None,
) -> bytes:
    img = _draw_background()
    draw = ImageDraw.Draw(img)

    # ── avatar with glow ring ──
    ax, ay = 90, (HEIGHT - AVATAR_SIZE) // 2
    ring = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse(
        [ax - 14, ay - 14, ax + AVATAR_SIZE + 14, ay + AVATAR_SIZE + 14],
        fill=(*ACCENT_LIGHT, 120),
    )
    ring = ring.filter(ImageFilter.GaussianBlur(12))
    img = Image.alpha_composite(img, ring)
    draw = ImageDraw.Draw(img)
    draw.ellipse(
        [ax - 8, ay - 8, ax + AVATAR_SIZE + 8, ay + AVATAR_SIZE + 8],
        outline=(*ACCENT_LIGHT, 255), width=6,
    )

    if avatar_bytes:
        try:
            avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA")
            avatar = avatar.resize((AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)
            img.paste(avatar, (ax, ay), _circle_mask(AVATAR_SIZE))
        except Exception:  # noqa: BLE001 — corrupt avatar must not break the card
            log.warning("Failed to decode avatar image; rendering placeholder")
            draw.ellipse([ax, ay, ax + AVATAR_SIZE, ay + AVATAR_SIZE], fill=ACCENT)
    else:
        draw.ellipse([ax, ay, ax + AVATAR_SIZE, ay + AVATAR_SIZE], fill=ACCENT)

    # ── text block ──
    tx = ax + AVATAR_SIZE + 70
    font_welcome = _load_font(40)
    font_name = _load_font(66)
    font_sub = _load_font(32, bold=False)
    font_badge = _load_font(30)

    draw.text((tx, 110), "WELCOME TO", font=font_welcome, fill=TEXT_SECONDARY)
    draw.text((tx, 158), server_name.upper()[:28], font=font_name, fill=TEXT_PRIMARY)

    # username (truncate gracefully)
    display = username if len(username) <= 26 else username[:24] + "…"
    draw.text((tx, 250), display, font=font_name, fill=ACCENT_LIGHT)

    # member number badge (rounded pill)
    badge_text = f"MEMBER  #{member_number}"
    bbox = draw.textbbox((0, 0), badge_text, font=font_badge)
    bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    bx, by = tx, 355
    draw.rounded_rectangle(
        [bx, by, bx + bw + 48, by + bh + 26], radius=(bh + 26) // 2, fill=ACCENT
    )
    draw.text((bx + 24, by + 10), badge_text, font=font_badge, fill=TEXT_PRIMARY)

    # branding (bottom-right) + optional logo
    brand_font = _load_font(26, bold=False)
    brand_text = f"⚡ {branding}"
    bb = draw.textbbox((0, 0), brand_text, font=brand_font)
    brand_x = WIDTH - (bb[2] - bb[0]) - 48
    draw.text((brand_x, HEIGHT - 60), brand_text, font=brand_font, fill=TEXT_SECONDARY)

    if logo_bytes:
        try:
            logo = Image.open(io.BytesIO(logo_bytes)).convert("RGBA")
            logo = logo.resize((72, 72), Image.LANCZOS)
            img.paste(logo, (WIDTH - 130, 30), _circle_mask(72))
        except Exception:  # noqa: BLE001
            pass

    # rounded card corners
    final = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    final.paste(img, (0, 0), _rounded_mask((WIDTH, HEIGHT), 36))

    buf = io.BytesIO()
    final.save(buf, "PNG", optimize=True)
    return buf.getvalue()


class WelcomeImageGenerator:
    """Async facade — downloads assets then renders off the event loop."""

    def __init__(self) -> None:
        self._session: aiohttp.ClientSession | None = None

    async def start(self) -> None:
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=10)
        )

    async def close(self) -> None:
        if self._session:
            await self._session.close()
            self._session = None

    async def _fetch(self, url: str | None) -> bytes | None:
        if not url or self._session is None:
            return None
        try:
            async with self._session.get(url) as resp:
                if resp.status == 200:
                    return await resp.read()
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            log.warning("Asset download failed (%s): %s", url, exc)
        return None

    async def generate(
        self,
        *,
        avatar_url: str | None,
        username: str,
        server_name: str,
        member_number: int,
        branding: str = "Developer Forge",
        logo_url: str | None = None,
    ) -> bytes | None:
        """Returns PNG bytes, or None on unrecoverable failure."""
        try:
            avatar_bytes = await self._fetch(avatar_url)
            logo_bytes = await self._fetch(logo_url)
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(
                None, _render_card, avatar_bytes, username,
                server_name, member_number, branding, logo_bytes,
            )
        except Exception:  # noqa: BLE001 — image failure must not break onboarding
            log.exception("Welcome image generation failed")
            return None
