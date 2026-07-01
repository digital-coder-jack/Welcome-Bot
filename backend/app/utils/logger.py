"""
logger.py
---------------------------------------------------------------------------
Central logging configuration for the backend. Import `logger` anywhere to get
a consistently-formatted logger honouring the LOG_LEVEL setting.
---------------------------------------------------------------------------
"""

import logging

from app.utils.config import settings


def _build_logger() -> logging.Logger:
    log = logging.getLogger("ai_moderation")
    if log.handlers:  # Avoid duplicate handlers on reload.
        return log

    handler = logging.StreamHandler()
    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    handler.setFormatter(formatter)
    log.addHandler(handler)
    log.setLevel(getattr(logging, settings.log_level.upper(), logging.INFO))
    log.propagate = False
    return log


logger = _build_logger()
