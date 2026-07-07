-- Developer Forge — Security & Protection schema (Part 2)
-- Loaded alongside schema.sql; fully additive, never destructive.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────
-- Per-guild security configuration (dashboard backing store)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_settings (
    guild_id                 INTEGER PRIMARY KEY,
    -- feature toggles
    enable_security          INTEGER NOT NULL DEFAULT 1,
    enable_ai_moderation     INTEGER NOT NULL DEFAULT 0,
    enable_spam_filter       INTEGER NOT NULL DEFAULT 1,
    enable_scam_detection    INTEGER NOT NULL DEFAULT 1,
    enable_raid_detection    INTEGER NOT NULL DEFAULT 1,
    enable_invite_protection INTEGER NOT NULL DEFAULT 1,
    enable_badword_filter    INTEGER NOT NULL DEFAULT 1,
    enable_mention_filter    INTEGER NOT NULL DEFAULT 1,
    enable_duplicate_filter  INTEGER NOT NULL DEFAULT 1,
    enable_username_check    INTEGER NOT NULL DEFAULT 1,
    enable_telegram_alerts   INTEGER NOT NULL DEFAULT 1,
    -- thresholds
    raid_join_threshold      INTEGER NOT NULL DEFAULT 8,     -- joins within window
    raid_window_seconds      INTEGER NOT NULL DEFAULT 30,
    raid_min_risk            INTEGER NOT NULL DEFAULT 60,    -- avg risk to auto-flag
    raid_auto_lockdown       INTEGER NOT NULL DEFAULT 0,
    spam_message_limit       INTEGER NOT NULL DEFAULT 6,     -- msgs within window
    spam_window_seconds      INTEGER NOT NULL DEFAULT 8,
    duplicate_limit          INTEGER NOT NULL DEFAULT 3,     -- identical msgs
    mention_user_limit       INTEGER NOT NULL DEFAULT 6,
    mention_role_limit       INTEGER NOT NULL DEFAULT 3,
    emoji_limit              INTEGER NOT NULL DEFAULT 15,
    caps_ratio               REAL    NOT NULL DEFAULT 0.80,  -- of long messages
    caps_min_length          INTEGER NOT NULL DEFAULT 20,
    timeout_minutes          INTEGER NOT NULL DEFAULT 10,
    high_risk_score          INTEGER NOT NULL DEFAULT 70,    -- 🔴 threshold
    medium_risk_score        INTEGER NOT NULL DEFAULT 40,    -- 🟡 threshold
    ai_min_confidence        REAL    NOT NULL DEFAULT 0.80,
    -- punishment per category: none|warn|delete|timeout|kick|ban
    punish_spam              TEXT NOT NULL DEFAULT 'timeout',
    punish_scam              TEXT NOT NULL DEFAULT 'timeout',
    punish_mention           TEXT NOT NULL DEFAULT 'timeout',
    punish_invite            TEXT NOT NULL DEFAULT 'warn',
    punish_badword           TEXT NOT NULL DEFAULT 'warn',
    punish_duplicate         TEXT NOT NULL DEFAULT 'warn',
    punish_ai                TEXT NOT NULL DEFAULT 'warn',
    -- JSON lists
    whitelist_domains_json   TEXT,   -- ["github.com", ...]
    whitelist_invites_json   TEXT,   -- ["devforge", ...] invite codes
    bad_words_json           TEXT,   -- ["word", "regex:pat", ...]
    allowed_roles_json       TEXT,   -- role ids fully bypassing checks
    ignored_channels_json    TEXT,
    ignored_roles_json       TEXT,
    ignored_users_json       TEXT,
    -- runtime state
    raid_mode_active         INTEGER NOT NULL DEFAULT 0,
    raid_mode_since          TEXT,
    updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────
-- Unified append-only security event log (the audit trail)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id        INTEGER NOT NULL,
    user_id         INTEGER,
    username        TEXT,
    event_type      TEXT NOT NULL,      -- join_risk|raid|spam|scam|mention_spam|
                                        -- invite|badword|duplicate|username|ai_flag|manual
    channel_id      INTEGER,
    message_id      INTEGER,
    risk_score      INTEGER,
    evidence        TEXT,               -- message content / JSON details
    action_taken    TEXT,               -- none|warn|delete|timeout|kick|ban|flag|lockdown
    moderator_id    INTEGER,            -- set for manual actions
    telegram_status TEXT,               -- sent|failed|skipped
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sec_events_guild_type
    ON security_events (guild_id, event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_sec_events_user
    ON security_events (guild_id, user_id);

-- Spam / scam history views (typed slices of the unified log)
CREATE VIEW IF NOT EXISTS spam_history AS
    SELECT * FROM security_events
    WHERE event_type IN ('spam', 'duplicate', 'mention_spam');
CREATE VIEW IF NOT EXISTS scam_history AS
    SELECT * FROM security_events WHERE event_type = 'scam';

-- ─────────────────────────────────────────────────────────────
-- Warnings issued by the security system or moderators
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warnings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    username     TEXT,
    reason       TEXT NOT NULL,
    event_type   TEXT,
    moderator_id INTEGER,               -- NULL = automatic
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings (guild_id, user_id);

-- ─────────────────────────────────────────────────────────────
-- Punishments applied (timeout / kick / ban) — timeouts included
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS punishments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    username      TEXT,
    punishment    TEXT NOT NULL,        -- timeout|kick|ban
    reason        TEXT,
    duration_secs INTEGER,              -- for timeouts
    event_type    TEXT,
    moderator_id  INTEGER,              -- NULL = automatic
    success       INTEGER NOT NULL DEFAULT 1,
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_punishments_user ON punishments (guild_id, user_id);

-- ─────────────────────────────────────────────────────────────
-- Raid incidents
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raid_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id       INTEGER NOT NULL,
    started_at     TEXT NOT NULL,
    ended_at       TEXT,
    join_count     INTEGER NOT NULL DEFAULT 0,
    avg_risk       INTEGER,
    user_ids_json  TEXT,                -- involved account ids
    actions_json   TEXT,                -- automatic actions performed
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_raid_history_guild ON raid_history (guild_id);

-- ─────────────────────────────────────────────────────────────
-- Join risk scores (one row per join analysis)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS risk_scores (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id       INTEGER NOT NULL,
    user_id        INTEGER NOT NULL,
    username       TEXT,
    risk_score     INTEGER NOT NULL,
    risk_level     TEXT NOT NULL,       -- low|medium|high
    factors_json   TEXT,                -- {"account_age_days": 2, ...}
    account_age_days REAL,
    during_raid    INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_risk_scores_user ON risk_scores (guild_id, user_id);

-- ─────────────────────────────────────────────────────────────
-- AI moderation verdicts
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_moderation_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    INTEGER NOT NULL,
    user_id     INTEGER,
    channel_id  INTEGER,
    message_id  INTEGER,
    content     TEXT,
    violation   INTEGER NOT NULL,
    confidence  REAL,
    category    TEXT,                   -- harassment|hate|threat|toxic|spam|scam|...
    reason      TEXT,
    action      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_results_guild ON ai_moderation_results (guild_id);
