"""
config.py
---------------------------------------------------------------------------
Typed application settings loaded from environment variables / .env.

Uses pydantic-settings so every value is validated and correctly typed, and a
single `settings` singleton is imported throughout the backend.
---------------------------------------------------------------------------
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Backend configuration, populated from environment variables."""

    # --- Groq ---
    groq_api_key: str = ""
    groq_model: str = "llama-3.3-70b-versatile"

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 8000

    # --- Moderation tuning ---
    min_confidence: float = 0.5

    # --- CORS ---
    allowed_origins: str = "*"

    # --- Logging ---
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @property
    def cors_origins(self) -> list[str]:
        """Parse the comma-separated ALLOWED_ORIGINS into a list."""
        if self.allowed_origins.strip() == "*":
            return ["*"]
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @property
    def groq_configured(self) -> bool:
        """Whether a real Groq API key has been provided."""
        return bool(self.groq_api_key) and not self.groq_api_key.startswith("your-")


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings singleton."""
    return Settings()


settings = get_settings()
