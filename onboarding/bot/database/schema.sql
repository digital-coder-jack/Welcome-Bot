-- Developer Forge — Onboarding schema
-- All tables are guild-scoped so future modules (security, leveling, ...)
-- can share the same database file safely.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────
-- Per-guild feature toggles + channel / role / branding config
-- (the "dashboard" backing store)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id                INTEGER PRIMARY KEY,
    enable_welcome          INTEGER NOT NULL DEFAULT 1,
    enable_welcome_image    INTEGER NOT NULL DEFAULT 1,
    enable_welcome_dm       INTEGER NOT NULL DEFAULT 1,
    enable_telegram         INTEGER NOT NULL DEFAULT 1,
    enable_invite_tracking  INTEGER NOT NULL DEFAULT 1,
    enable_activity_unlock  INTEGER NOT NULL DEFAULT 1,
    enable_auto_role        INTEGER NOT NULL DEFAULT 1,
    welcome_channel_id      INTEGER,
    rules_channel_id        INTEGER,
    dev_intro_channel_id    INTEGER,
    chill_zone_channel_id   INTEGER,
    tech_news_channel_id    INTEGER,
    new_member_role_id      INTEGER,
    forge_member_role_id    INTEGER,
    remove_new_member_role  INTEGER NOT NULL DEFAULT 1,
    website_url             TEXT,
    embed_color             INTEGER,
    embed_footer            TEXT,
    branding                TEXT,
    server_logo_url         TEXT,
    unlock_reaction         TEXT,
    button_labels_json      TEXT,               -- JSON: {"rules": "...", ...}
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────
-- Master member record (one row per guild+user)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
    guild_id              INTEGER NOT NULL,
    user_id               INTEGER NOT NULL,
    username              TEXT NOT NULL,
    display_name          TEXT,
    is_bot               INTEGER NOT NULL DEFAULT 0,
    member_number        INTEGER,
    joined_at            TEXT,
    account_created_at   TEXT,
    welcome_sent         INTEGER NOT NULL DEFAULT 0,
    dm_sent              INTEGER NOT NULL DEFAULT 0,
    forge_member_awarded INTEGER NOT NULL DEFAULT 0,
    first_message_time   TEXT,
    first_message_channel INTEGER,
    invite_code          TEXT,
    inviter_id           INTEGER,
    inviter_name         TEXT,
    telegram_sent        INTEGER NOT NULL DEFAULT 0,
    telegram_status      TEXT,
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_awarded
    ON members (guild_id, forge_member_awarded);

-- ─────────────────────────────────────────────────────────────
-- Append-only join history (a user may join/leave repeatedly)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS join_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id       INTEGER NOT NULL,
    user_id        INTEGER NOT NULL,
    joined_at      TEXT NOT NULL,
    joined_channel INTEGER,
    member_number  INTEGER,
    invite_code    TEXT,
    inviter_id     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_join_history_user
    ON join_history (guild_id, user_id);

-- ─────────────────────────────────────────────────────────────
-- Invite usage snapshots / attribution
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invite_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     INTEGER NOT NULL,
    invite_code  TEXT NOT NULL,
    inviter_id   INTEGER,
    inviter_name TEXT,
    used_by      INTEGER,
    used_at      TEXT NOT NULL DEFAULT (datetime('now')),
    uses         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invite_history_guild
    ON invite_history (guild_id, invite_code);

-- ─────────────────────────────────────────────────────────────
-- DM delivery attempts (welcome / forge congratulation)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dm_status (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id  INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    dm_type   TEXT NOT NULL,            -- 'welcome' | 'forge_member'
    success   INTEGER NOT NULL,
    error     TEXT,
    sent_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dm_status_user
    ON dm_status (guild_id, user_id);

-- ─────────────────────────────────────────────────────────────
-- Role rewards granted by the bot
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_rewards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    role_id    INTEGER NOT NULL,
    reward_key TEXT NOT NULL,           -- 'new_member' | 'forge_member'
    granted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_rewards
    ON role_rewards (guild_id, user_id, reward_key);

-- ─────────────────────────────────────────────────────────────
-- Activity unlock progress (first-message tracking)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_progress (
    guild_id              INTEGER NOT NULL,
    user_id               INTEGER NOT NULL,
    first_message_id      INTEGER,
    first_message_time    TEXT,
    first_message_channel INTEGER,
    first_message_content TEXT,
    completed             INTEGER NOT NULL DEFAULT 0,
    completed_at          TEXT,
    PRIMARY KEY (guild_id, user_id)
);

-- ─────────────────────────────────────────────────────────────
-- Telegram delivery audit log
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     INTEGER,
    user_id      INTEGER,
    event_type   TEXT NOT NULL,         -- 'member_joined' | 'forge_unlocked' | ...
    success      INTEGER NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 1,
    error        TEXT,
    sent_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_telegram_logs_guild
    ON telegram_logs (guild_id, event_type);

-- ─────────────────────────────────────────────────────────────
-- Extra welcome presentation settings (kept separate so the
-- welcome module stays plug-and-play for future modules)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS welcome_settings (
    guild_id        INTEGER PRIMARY KEY,
    welcome_title   TEXT,
    welcome_message TEXT,
    dm_message      TEXT,
    image_style     TEXT DEFAULT 'tech-blue',
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
