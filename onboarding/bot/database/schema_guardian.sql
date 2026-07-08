-- ═════════════════════════════════════════════════════════════
-- Forge Guardian (Final Update) — moderator-approval workflow,
-- guardian settings (language / alert channels / security team),
-- and moderation-log bookkeeping. Applied automatically on connect.
-- ═════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- Per-guild Guardian settings
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guardian_settings (
    guild_id                   INTEGER PRIMARY KEY,
    language                   TEXT NOT NULL DEFAULT 'en',   -- en|es|fr|de|hi|pt
    security_alerts_channel_id INTEGER,                      -- #security-alerts
    modlog_channel_id          INTEGER,                      -- #mod-logs
    security_team_role_id      INTEGER,                      -- role allowed to approve
    notify_owner               INTEGER NOT NULL DEFAULT 1,   -- DM owner on reviews
    enable_modlog              INTEGER NOT NULL DEFAULT 1,
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────
-- Moderation reviews — every kick/ban proposal waits here until
-- an authorized moderator presses a button. NOTHING is executed
-- automatically.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mod_reviews (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id           INTEGER NOT NULL,
    user_id            INTEGER NOT NULL,
    username           TEXT,
    source             TEXT NOT NULL,             -- warn_l3 | automod | raid | manual
    violation          TEXT,                      -- what was detected
    recommended_action TEXT NOT NULL DEFAULT 'kick',  -- warn|timeout|kick|ban|manual_review
    confidence         TEXT NOT NULL DEFAULT 'medium', -- low | medium | high
    risk_score         INTEGER,
    evidence_json      TEXT,                      -- list[str] evidence lines
    history_json       TEXT,                      -- warning history snapshot
    timeline_json      TEXT,                      -- violation timeline snapshot
    account_created_at TEXT,
    joined_at          TEXT,
    roles_text         TEXT,
    warning_count      INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'pending',
                       -- pending | processing | approved_warn | approved_timeout
                       -- | approved_kick | approved_ban | dismissed | expired
    claimed_by         INTEGER,                   -- moderator who pressed a button
    resolved_by        INTEGER,
    resolved_action    TEXT,
    resolved_at        TEXT,
    alert_channel_id   INTEGER,
    alert_message_id   INTEGER,                   -- security-alert embed message
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- one PENDING review per member per guild → no duplicate alerts
CREATE UNIQUE INDEX IF NOT EXISTS idx_mod_reviews_pending
    ON mod_reviews (guild_id, user_id) WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_mod_reviews_guild
    ON mod_reviews (guild_id, status);
CREATE INDEX IF NOT EXISTS idx_mod_reviews_msg
    ON mod_reviews (alert_message_id);

-- ─────────────────────────────────────────────────────────────
-- Moderation log entries (mirror of what was posted to #mod-logs)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modlog_entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     INTEGER NOT NULL,
    action       TEXT NOT NULL,          -- join|leave|kick|ban|unban|timeout|...
    user_id      INTEGER,
    username     TEXT,
    moderator_id INTEGER,
    reason       TEXT,
    channel_id   INTEGER,
    evidence     TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_modlog_guild ON modlog_entries (guild_id, created_at);
