"""
ForgeBot — the application core.

Owns shared resources (database, telegram, invite tracker, image
generator) and exposes them to every cog. New modules (security, AI
moderation, verification, tickets, ...) plug in by simply dropping a cog
into bot/cogs/ — they get the same shared services with zero rewiring.
"""
from __future__ import annotations

import pkgutil

import discord
from discord.ext import commands

from bot.core.config import Config
from bot.core.logging import get_logger
from bot.database.db import Database
from bot.database.guardian_store import GuardianStore
from bot.database.intel_store import IntelStore
from bot.database.security_store import SecurityStore
from bot.services.i18n import I18n
from bot.services.intel.collector import ProfileCollector
from bot.services.invites import InviteTracker
from bot.services.security.actions import ActionExecutor
from bot.services.security.review import ReviewManager
from bot.services.security.ai_moderation import AIModerationClient
from bot.services.security.badwords import BadWordFilter
from bot.services.security.raid import RaidDetector
from bot.services.security.risk import RiskAnalyzer
from bot.services.security.scam import ScamScanner
from bot.services.security.spam import SpamDetector
from bot.services.telegram import TelegramNotifier
from bot.services.welcome_image import WelcomeImageGenerator

log = get_logger("core")

COGS_PACKAGE = "bot.cogs"


class ForgeBot(commands.Bot):
    """Developer Forge bot with shared service container."""

    def __init__(self, config: Config) -> None:
        intents = discord.Intents.default()
        intents.members = True          # member join events
        intents.message_content = True  # first-message detection
        intents.invites = True          # invite tracking
        if config.enable_presence_intent:
            # optional privileged intent — richer status/activity collection
            intents.presences = True

        super().__init__(
            command_prefix=commands.when_mentioned_or("!forge "),
            intents=intents,
            help_command=None,
            chunk_guilds_at_startup=False,  # large-server friendly
            member_cache_flags=discord.MemberCacheFlags.from_intents(intents),
        )

        self.config = config
        self.db = Database(config.database_path)
        self.telegram = TelegramNotifier(config.telegram, self.db)
        self.invite_tracker = InviteTracker()
        self.image_generator = WelcomeImageGenerator()

        # ── member intelligence (v2.0) — shared with all cogs ──
        self.intel_store = IntelStore(self.db)
        self.profile_collector = ProfileCollector(self)

        # ── security services (Part 2) — shared with all cogs ──
        self.security_store = SecurityStore(self.db)
        self.risk_analyzer = RiskAnalyzer()
        self.raid_detector = RaidDetector()
        self.spam_detector = SpamDetector()
        self.scam_scanner = ScamScanner()
        self.badword_filter = BadWordFilter()
        self.action_executor = ActionExecutor(self.security_store)

        # ── Forge Guardian (final update) ──────────────────────
        self.i18n = I18n()
        self.guardian_store = GuardianStore(self.db)
        self.review_manager = ReviewManager(self)
        # route every automatic kick/ban proposal through moderator approval
        self.action_executor.review_manager = self.review_manager

        self.ai_moderation = AIModerationClient(
            groq_api_key=config.security.groq_api_key,
            groq_model=config.security.groq_model,
            backend_url=config.security.moderation_api_url,
        )

    # ── lifecycle ────────────────────────────────────────────

    async def setup_hook(self) -> None:
        await self.db.connect()
        await self.telegram.start()
        await self.image_generator.start()
        await self.ai_moderation.start()
        await self._load_cogs()
        await self.tree.sync()
        log.info("Slash commands synced")

    async def on_interaction(self, interaction: discord.Interaction) -> None:
        """Dispatch Forge Guardian review buttons (restart-safe: the review
        id is embedded in the component custom_id, so no in-memory view
        state is required after a restart)."""
        if interaction.type is discord.InteractionType.component:
            try:
                await self.review_manager.handle_interaction(interaction)
            except Exception:  # noqa: BLE001 — never break other interactions
                log.exception("Review button dispatch failed")

    async def _load_cogs(self) -> None:
        """Auto-discover every cog module in bot/cogs — future modules
        (security, moderation, tickets, ...) are picked up automatically."""
        import bot.cogs as cogs_pkg

        for module in pkgutil.iter_modules(cogs_pkg.__path__):
            if module.name.startswith("_"):
                continue
            ext = f"{COGS_PACKAGE}.{module.name}"
            try:
                await self.load_extension(ext)
                log.info("Loaded cog: %s", ext)
            except Exception:  # noqa: BLE001 — one bad cog must not kill the bot
                log.exception("Failed to load cog: %s", ext)

    async def on_ready(self) -> None:
        log.info("Logged in as %s (%s) — %d guild(s)",
                 self.user, self.user.id if self.user else "?", len(self.guilds))
        for guild in self.guilds:
            await self.invite_tracker.cache_guild(guild)
        await self.change_presence(
            activity=discord.Activity(
                type=discord.ActivityType.watching,
                name="new members ⚡ Developer Forge",
            )
        )

    async def close(self) -> None:
        log.info("Shutting down…")
        await self.ai_moderation.close()
        await self.telegram.close()
        await self.image_generator.close()
        await self.db.close()
        await super().close()

    # ── global invite cache maintenance ──────────────────────

    async def on_invite_create(self, invite: discord.Invite) -> None:
        self.invite_tracker.add_invite(invite)

    async def on_invite_delete(self, invite: discord.Invite) -> None:
        self.invite_tracker.remove_invite(invite)

    async def on_guild_join(self, guild: discord.Guild) -> None:
        await self.invite_tracker.cache_guild(guild)
        await self.db.get_guild_settings(guild.id)  # provision defaults
