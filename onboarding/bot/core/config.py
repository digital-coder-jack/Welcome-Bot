"""
Developer Forge — Central configuration.

All secrets & deployment-specific values come from environment variables
(.env supported via python-dotenv). Per-guild behaviour is configured at
runtime through the /welcome-config dashboard and persisted in the DB —
these env values act only as global defaults / credentials.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _env(key: str, default: str | None = None, *, required: bool = False) -> str:
    value = os.getenv(key, default)
    if required and not value:
        raise RuntimeError(f"Missing required environment variable: {key}")
    return value or ""


def _env_int(key: str, default: int = 0) -> int:
    raw = os.getenv(key)
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _env_bool(key: str, default: bool = True) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class TelegramConfig:
    """Credentials for the owner-only Telegram notification channel."""

    bot_token: str = field(default_factory=lambda: _env("TELEGRAM_BOT_TOKEN"))
    chat_id: str = field(default_factory=lambda: _env("TELEGRAM_CHAT_ID"))
    max_retries: int = field(default_factory=lambda: _env_int("TELEGRAM_MAX_RETRIES", 3))
    retry_delay: float = 2.0

    @property
    def enabled(self) -> bool:
        return bool(self.bot_token and self.chat_id)


@dataclass(frozen=True)
class Defaults:
    """Global fallback defaults; per-guild DB settings always win."""

    embed_color: int = field(default_factory=lambda: _env_int("EMBED_COLOR", 0x2E86DE))
    website_url: str = field(default_factory=lambda: _env("WEBSITE_URL", "https://developerforge.dev"))
    branding: str = field(default_factory=lambda: _env("BRANDING", "Developer Forge"))
    footer: str = field(default_factory=lambda: _env("EMBED_FOOTER", "Developer Forge • Build. Learn. Ship."))
    unlock_reaction: str = field(default_factory=lambda: _env("UNLOCK_REACTION", "🔥"))


@dataclass(frozen=True)
class SecurityConfig:
    """Global security credentials — per-guild behaviour lives in the DB."""

    # Direct Groq API for AI moderation (recommended)
    groq_api_key: str = field(default_factory=lambda: _env("GROQ_API_KEY"))
    groq_model: str = field(
        default_factory=lambda: _env("GROQ_MODEL", "llama-3.3-70b-versatile")
    )
    # Optional: reuse the FastAPI moderation backend instead of direct Groq
    moderation_api_url: str = field(default_factory=lambda: _env("MODERATION_API_URL"))


@dataclass(frozen=True)
class Config:
    """Top-level application configuration."""

    discord_token: str = field(default_factory=lambda: _env("DISCORD_TOKEN", required=True))
    database_path: Path = field(
        default_factory=lambda: Path(_env("DATABASE_PATH", "data/developer_forge.db"))
    )
    log_level: str = field(default_factory=lambda: _env("LOG_LEVEL", "INFO"))
    log_file: str = field(default_factory=lambda: _env("LOG_FILE", "logs/bot.log"))
    assets_dir: Path = field(default_factory=lambda: Path(_env("ASSETS_DIR", "assets")))
    telegram: TelegramConfig = field(default_factory=TelegramConfig)
    security: SecurityConfig = field(default_factory=SecurityConfig)
    defaults: Defaults = field(default_factory=Defaults)


def load_config() -> Config:
    """Build and validate the application configuration."""
    return Config()
