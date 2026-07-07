"""
Developer Forge — Welcome & Onboarding System.

Entry point: loads config, sets up structured logging and runs the bot.
"""
from __future__ import annotations

import asyncio
import sys

from bot.core.bot import ForgeBot
from bot.core.config import load_config
from bot.core.logging import get_logger, setup_logging


async def main() -> None:
    try:
        config = load_config()
    except RuntimeError as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        print("Copy .env.example to .env and fill in your credentials.", file=sys.stderr)
        sys.exit(1)

    setup_logging(config.log_level, config.log_file)
    log = get_logger("main")

    bot = ForgeBot(config)
    try:
        log.info("Starting Developer Forge onboarding bot…")
        await bot.start(config.discord_token)
    except KeyboardInterrupt:
        log.info("Interrupted — shutting down")
    finally:
        if not bot.is_closed():
            await bot.close()


if __name__ == "__main__":
    asyncio.run(main())
