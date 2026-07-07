-- Developer Forge — v2.0 Member Intelligence & Moderation schema (Part 3)
-- Loaded alongside schema.sql / schema_security.sql; fully additive.
--
-- ⚠ Discord API honesty note:
--   The official Bot API does NOT expose: connected accounts (GitHub/Spotify/
--   Steam/...), About Me / bio, pronouns, mutual-server lists or join source.
--   This schema stores ONLY what bots can legitimately read. The
--   connected_accounts table exists for forward-compatibility and is filled
--   only if Discord ever exposes such data to bots — never via scraping.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────
-- One permanent intelligence record per guild+user
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
    guild_id            INTEGER NOT NULL,
    user_id             INTEGER NOT NULL,
    -- identity
    username            TEXT,               -- unique username (name#0 → name)
    display_name        TEXT,               -- resolved display name
    global_name         TEXT,               -- global display name
    nickname            TEXT,               -- per-guild nickname
    is_bot              INTEGER NOT NULL DEFAULT 0,
    -- timestamps
    account_created_at  TEXT,
    joined_at           TEXT,
    -- roles & permissions
    roles_json          TEXT,               -- [{"id":..,"name":..}, ...]
    highest_role        TEXT,
    permissions_json    TEXT,               -- ["administrator", ...] key perms
    is_admin            INTEGER NOT NULL DEFAULT 0,
    -- appearance
    avatar_url          TEXT,
    guild_avatar_url    TEXT,
    banner_url          TEXT,
    accent_color        INTEGER,
    -- presence (requires privileged presence intent — optional)
    status              TEXT,               -- online|idle|dnd|offline|unknown
    activities_json     TEXT,
    custom_status       TEXT,
    -- flags & perks
    public_flags_json   TEXT,               -- badge names from public flags
    premium_since       TEXT,               -- server booster since (NULL = not)
    is_booster          INTEGER NOT NULL DEFAULT 0,
    timed_out_until     TEXT,               -- active timeout expiry
    is_pending          INTEGER NOT NULL DEFAULT 0,  -- membership screening
    -- attribution
    invite_code         TEXT,
    inviter_id          INTEGER,
    -- lifecycle counters
    join_count          INTEGER NOT NULL DEFAULT 0,
    leave_count         INTEGER NOT NULL DEFAULT 0,
    rejoin_count        INTEGER NOT NULL DEFAULT 0,
    -- bookkeeping
    imported            INTEGER NOT NULL DEFAULT 0,  -- 1 = initial scan import
    welcome_sent        INTEGER NOT NULL DEFAULT 0,
    in_guild            INTEGER NOT NULL DEFAULT 1,  -- currently a member?
    security_notes      TEXT,
    telegram_log_id     TEXT,               -- last Telegram message reference
    collected_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen           TEXT,
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_profiles_guild ON user_profiles (guild_id, in_guild);

-- ─────────────────────────────────────────────────────────────
-- Append-only change history (username / nickname / avatar / roles / ...)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profile_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    field       TEXT NOT NULL,      -- username|global_name|nickname|avatar|
                                    -- banner|roles|status|booster|timeout
    old_value   TEXT,
    new_value   TEXT,
    changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_profile_history_user
    ON profile_history (guild_id, user_id, field);

-- ─────────────────────────────────────────────────────────────
-- Append-only membership lifecycle events (join / leave / rejoin / import)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS member_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    username    TEXT,
    event_type  TEXT NOT NULL,      -- join|leave|rejoin|import|kick|ban
    detail      TEXT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_member_events_user
    ON member_events (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_member_events_type
    ON member_events (guild_id, event_type, occurred_at);

-- ─────────────────────────────────────────────────────────────
-- Connected accounts (forward-compatibility ONLY — see header note).
-- Discord's Bot API currently exposes NO third-party connections;
-- this table stays empty unless Discord officially adds support.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connected_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    provider     TEXT NOT NULL,     -- github|spotify|steam|...
    account_name TEXT,
    account_url  TEXT,
    source       TEXT NOT NULL DEFAULT 'official_api',
    collected_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (guild_id, user_id, provider)
);

-- ─────────────────────────────────────────────────────────────
-- First-run scan bookkeeping (existing-members import, once per guild)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS intel_scan_state (
    guild_id     INTEGER PRIMARY KEY,
    scanned      INTEGER NOT NULL DEFAULT 0,
    member_count INTEGER,
    started_at   TEXT,
    finished_at  TEXT
);

-- ─────────────────────────────────────────────────────────────
-- Three-level warning system configuration (per guild)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warning_settings (
    guild_id           INTEGER PRIMARY KEY,
    level3_action      TEXT NOT NULL DEFAULT 'kick',   -- kick | ban
    dm_on_warn         INTEGER NOT NULL DEFAULT 1,
    reset_after_action INTEGER NOT NULL DEFAULT 1,     -- clear count post-removal
    level1_message     TEXT,                           -- custom overrides
    level2_message     TEXT,
    level3_message     TEXT,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────
-- Moderator action audit (3-level system) — richer than punishments
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mod_actions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    username      TEXT,
    action        TEXT NOT NULL,     -- warn_l1|warn_l2|warn_l3_kick|warn_l3_ban|clear
    level         INTEGER,
    reason        TEXT,
    moderator_id  INTEGER,
    moderator_tag TEXT,
    dm_delivered  INTEGER,
    history_json  TEXT,              -- snapshot of prior warnings at action time
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mod_actions_user ON mod_actions (guild_id, user_id);
