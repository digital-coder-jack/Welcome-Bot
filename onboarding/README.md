# ⚡ Developer Forge — Welcome, Onboarding & Security System

A **production-ready, modular Discord bot** built with the latest
**discord.py 2.x**. New members get a premium welcome experience (embed +
generated welcome card + interactive buttons + personalized DM), while an
**enterprise-grade security layer** protects the server from raids, spam,
scams and abuse. The server owner receives **private Telegram notifications**
— sensitive member/security data never appears in public Discord channels.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🟢 **Member Join Pipeline** | Auto role → welcome embed → premium image → buttons → DM → DB → Telegram |
| 🖼 **Welcome Card Generator** | High-res Pillow-rendered tech-blue card: avatar, glow ring, member #, branding, logo |
| 🎛 **Interactive Buttons** | 📖 Rules · 👋 Dev Intro · 💬 Chill Zone · 📰 Tech News · 🌐 Website — all labels configurable |
| 👤 **Auto Role** | Assigns **New Member** role instantly (configurable role ID) |
| 💌 **Welcome DM** | Beautiful personalized DM; DM-disabled users handled silently & logged to DB |
| 🔥 **Activity Unlock** | First valid message in **#chill-zone** → **Forge Member** role, exactly once (atomic DB claim + per-user locks) |
| 🎉 **Forge Member DM** | Congratulation DM encouraging projects, discussions, AI talk, events |
| 📨 **Invite Tracking** | Snapshot-diff attribution of invite code + inviter on every join |
| 📲 **Telegram Owner Alerts** | HTML-formatted join & unlock notifications with retry, rate-limit handling & audit log |
| 🗄 **Full Persistence** | 9 tables: guild settings, members, join/invite history, DM status, role rewards, activity progress, telegram logs, welcome settings |
| ⚙️ **/forge Dashboard** | Slash-command configuration of every toggle, channel, role, label, color & branding |

### 🛡 Security & Protection (Part 2)

| Feature | Description |
|---|---|
| 📊 **Join Risk Analysis** | Every join scored 0–100 (account age, avatar, username patterns, rejoin history, raid context) → 🟢/🟡/🔴, stored + Telegram alert |
| ⚔️ **Raid Detection** | Sliding-window join monitor; auto raid mode, optional channel lockdown, auto-recovery after cooldown, full incident history |
| 🚨 **Spam Detection** | Message-rate floods, copy-paste & cross-channel duplicates, emoji spam, caps abuse, character flooding, repeated attachments/stickers |
| 📣 **Mention Protection** | @everyone/@here abuse, user & role mention limits |
| ☠️ **Scam & Phishing** | Nitro/giveaway/crypto/steam/verification scams, known malicious & lookalike domains, URL shorteners, obfuscated links (`hxxp`, `(dot)`) |
| 🔗 **Invite Protection** | Blocks external server ads; whitelist + own-guild invites always allowed |
| 🧼 **Bad Word Filter** | Custom word list, `regex:` entries, unicode NFKC folding, leetspeak/homoglyph bypass detection |
| 🤖 **AI Moderation** | **Groq API** (direct, JSON-mode) analyses harassment/hate/threats/toxicity/scams; per-guild confidence threshold, fail-open, cooldown + dedupe |
| 🕵️ **Username Screening** | Deceptive/random usernames flagged for review — never auto-banned |
| 🔨 **Configurable Punishments** | Per category: none / warn / delete / timeout / kick / ban — hierarchy-safe with full audit |
| 📲 **Private Security Alerts** | Suspicious joins, spam, scams, raids, invites, AI flags → owner's Telegram only |
| 🗄 **Complete Audit Trail** | `security_events`, `warnings`, `punishments`, `raid_history`, `risk_scores`, `ai_moderation_results` + spam/scam history views |
| ⚙️ **/security Dashboard** | Toggles, thresholds, punishments, whitelists, ignore lists, manual raid mode — all per guild |

---

### 🚀 v2.0 Upgrade — 3-Level Warnings, Premium DM & Member Intelligence

| Feature | Description |
|---|---|
| 💬⚠️🔨 **3-Level Warning System** | `/warn issue` escalates: **L1** friendly reminder (no punishment) → **L2** official warning (stored permanently) → **L3** auto **kick/ban** (configurable) with DM explanation, full history snapshot & Telegram report. `/warn history · clear · config` |
| 💎 **Premium Welcome DM** | 4 themed embeds (👋 Welcome → 🚀 Start Here → 📜 Rules → 🎉 Community) with **animated GIF banner**, server logo, nice colors and link buttons: 📜 Rules · 📖 Community Guide · 💬 Chill Zone · 🆘 Support · 🤝 Invite Friends · 🌐 Website. Graceful fallback to the classic v1 DM |
| 🎬 **Welcome Animation** | High-quality animated GIF banners (Discord embeds can't autoplay MP4 — GIF is the supported alternative, used automatically). Custom banner per guild via `dm_banner_url` |
| 🗂 **Member Intelligence DB** | One permanent record per member: username/global/display/nick, bot flag, created/joined dates, roles, highest role, key permissions, avatar/guild-avatar/banner URLs, accent color, status & activities (presence intent optional), badges/public flags, booster status, timeout status, pending screening, invite attribution, join/leave/rejoin counters, collected/updated/last-seen timestamps |
| 📜 **Change History** | Username, global name, nickname, avatar, banner, roles, booster & timeout changes → append-only `profile_history` + Telegram change reports |
| 🗃 **Existing-Members Scan** | First startup scans **every existing member** in batches (200/transaction, gateway-streamed, zero HTTP calls) — marked `Imported=True, Welcome Sent=False`, **no welcome messages sent**. `/intel rescan` re-runs on demand |
| 📲 **Telegram Security Logs** | Formatted reports for: new user / rejoin / leave, profile changes, warnings L1-L3, kick/ban final actions, scan completion — with the `━━━` report layout |
| 🔍 **/intel Dashboard** | `/intel profile · history · note · rescan · stats` — full record lookups, change history, security notes, DB statistics (admin-only) |

#### ⚠️ Discord API limitations (documented honestly)

| Requested | Status | Closest supported alternative |
|---|---|---|
| Connected accounts (GitHub/Spotify/Steam/…) | ❌ Not exposed to bots (OAuth2 user-consent only) | `connected_accounts` table exists for forward-compatibility; **never scraped** |
| About Me / bio, pronouns | ❌ Not exposed to bots | Custom status is collected when presence intent is on |
| Mutual server count | ❌ Not exposed | — |
| Join source | ❌ Not exposed | Invite-usage diffing attribution (already implemented) |
| Online status / activities | ⚠️ Privileged **PRESENCES** intent | Set `ENABLE_PRESENCE_INTENT=true` + enable in Dev Portal; stored as `unknown` otherwise |
| MP4 autoplay in embeds | ❌ Not supported by Discord | Animated GIF banners (used automatically) |

Nothing outside the official Bot API is ever used — no self-bots, no scraping.

---

## 🏗 Architecture

```
onboarding/
├── main.py                     # Entry point
├── requirements.txt
├── .env.example
└── bot/
    ├── core/
    │   ├── bot.py              # ForgeBot — service container + cog auto-loader
    │   ├── config.py           # Env-based configuration (dataclasses)
    │   └── logging.py          # Structured logging (console + rotating file)
    ├── database/
    │   ├── schema.sql          # Onboarding schema (9 tables, WAL mode)
    │   ├── schema_security.sql # Security schema (7 tables + 2 views) — auto-applied
    │   ├── db.py               # Async abstraction layer (aiosqlite) — no SQL in cogs
    │   └── security_store.py   # Security data access layer (settings cache + audit)
    ├── services/
    │   ├── telegram.py         # Owner notifier: retries, 429 handling, audit log
    │   ├── invites.py          # Invite-use snapshot diffing
    │   ├── welcome_image.py    # Pillow card renderer (thread-executor, non-blocking)
    │   └── security/
    │       ├── risk.py         # Join risk scoring (0–100)
    │       ├── raid.py         # Sliding-window raid detector
    │       ├── spam.py         # Rate / duplicate / emoji / caps / flood / mentions
    │       ├── scam.py         # Phishing, malicious domains, invite scanning
    │       ├── badwords.py     # Word list + regex + unicode-fold bypass detection
    │       ├── ai_moderation.py# Groq client (direct or backend proxy), fail-open
    │       ├── actions.py      # Punishment executor + raid lockdown (audited)
    │       └── alerts.py       # Telegram security alert builders
    ├── services/intel/         # v2.0 member intelligence
    │   ├── collector.py        # Official-API-only profile snapshots
    │   └── reports.py          # Telegram security report builders
    ├── cogs/
    │   ├── welcome.py          # Member-join pipeline (v2.0 premium DM)
    │   ├── activity.py         # First-message 🔥 Forge Member unlock
    │   ├── admin.py            # /forge configuration dashboard
    │   ├── security.py         # Real-time protection pipeline (joins + messages)
    │   ├── security_admin.py   # /security configuration dashboard
    │   ├── warnings3.py        # v2.0 /warn 3-level warning system
    │   └── intel.py            # v2.0 /intel member intelligence + first-run scan
    └── utils/
        ├── embeds.py           # Premium blue-theme embed builders
        ├── premium_dm.py       # v2.0 multi-embed welcome DM + GIF banners
        ├── views.py            # Configurable welcome buttons
        └── formatting.py       # Timestamps, account age, ordinals
```

**Future-module ready:** cogs are auto-discovered from `bot/cogs/` — drop in
`security.py`, `verification.py`, `tickets.py`, `leveling.py`, etc. and they
instantly share the same database, config, logging and Telegram services.
No rewiring of the welcome system needed.

---

## 🚀 Setup

### 1. Discord Application
1. Create an app at <https://discord.com/developers/applications>
2. **Bot** tab → enable **SERVER MEMBERS INTENT** and **MESSAGE CONTENT INTENT**
   *(optional for v2.0)* also enable **PRESENCE INTENT** and set
   `ENABLE_PRESENCE_INTENT=true` in `.env` for live status/activity collection
   *(also grant `Kick Members` / `Ban Members` for the Level-3 warning action)*
3. Invite with permissions: `Manage Roles`, `Send Messages`, `Embed Links`,
   `Attach Files`, `Add Reactions`, `Manage Server` (for invite tracking)
4. Make sure the bot's role sits **above** the New Member / Forge Member roles.

### 2. Telegram Bot (owner notifications)
1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy token
2. Send `/start` to your new bot
3. Get your chat id: `https://api.telegram.org/bot<TOKEN>/getUpdates`

### 3. Groq API (AI moderation)
1. Get a free API key at <https://console.groq.com/keys>
2. Set `GROQ_API_KEY` in `.env` (model defaults to `llama-3.3-70b-versatile`)
3. Enable per guild: `/security toggle feature:ai_moderation enabled:true`

### 4. Run
```bash
cd onboarding
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in DISCORD_TOKEN, TELEGRAM_*, GROQ_API_KEY
python main.py
```

### 5. Configure in Discord (admin only)
```
/forge channel  target:welcome     channel:#welcome
/forge channel  target:chill_zone  channel:#chill-zone
/forge channel  target:rules       channel:#rules
/forge channel  target:dev_intro   channel:#dev-intro
/forge channel  target:tech_news   channel:#tech-news
/forge role     target:new_member    role:@👤 New Member
/forge role     target:forge_member  role:@🔥 Forge Member
/forge branding website_url:https://your.site embed_color:#2E86DE
/forge button   button:rules label:📖 Rules
/forge toggle   feature:telegram enabled:true
/forge settings                     # view the full dashboard
```

### 6. Security configuration (admin only)
```
/security settings                                  # full security dashboard
/security toggle     feature:ai_moderation enabled:true
/security threshold  name:raid_join_threshold value:8
/security threshold  name:timeout_minutes    value:10
/security punishment category:scam  punishment:timeout
/security list       name:whitelist_domains  action:add value:github.com
/security list       name:whitelist_invites  action:add value:devforge
/security list       name:bad_words          action:add value:regex:badpat\d+
/security list       name:ignored_channels   action:add value:#bot-commands
/security raidmode   enabled:true                    # manual lockdown
/security events     event_type:scam                 # recent incidents
/security warnings   member:@user
```

### 7. v2.0 — Warnings & Member Intelligence (moderator / admin)
```
# 3-level warning system (Moderate Members permission)
/warn issue    member:@user reason:Spamming memes in #general
/warn history  member:@user            # full warning + action history
/warn clear    member:@user            # reset to Level 1 (admin)
/warn config   level3_action:ban dm_on_warn:true reset_after_action:true

# member intelligence database (Administrator permission)
/intel profile  member:@user           # complete intelligence record
/intel history  member:@user           # username/nickname/avatar/role changes
/intel note     member:@user note:Verified via modmail
/intel rescan                          # force a full member re-scan
/intel stats                           # database statistics

# customise the premium welcome DM (optional)
/forge messages dm_message:Your custom intro...
/forge messages dm_banner_url:https://media.giphy.com/media/.../giphy.gif
```
> **First startup:** the bot automatically scans every existing member into
> the intelligence database (marked `Imported=True`, `Welcome Sent=False`) —
> **no welcome messages are sent** during the import. Watch your Telegram
> for the scan-complete report.

---

## 🗄 Data Model (key columns)

`members`: `guild_id`, `user_id`, `member_number`, `joined_at`,
`account_created_at`, `welcome_sent`, `dm_sent`, `forge_member_awarded`,
`first_message_time`, `first_message_channel`, `invite_code`, `inviter_id`,
`telegram_sent`, `telegram_status` — plus append-only `join_history`,
`invite_history`, `dm_status`, `role_rewards`, `activity_progress`,
`telegram_logs`, and per-guild `guild_settings` / `welcome_settings`.

**Security tables:** `security_settings` (per-guild config), `security_events`
(`guild_id`, `user_id`, `event_type`, `channel_id`, `message_id`, `risk_score`,
`evidence`, `action_taken`, `moderator_id`, `telegram_status`, `created_at`),
`warnings`, `punishments`, `raid_history`, `risk_scores`,
`ai_moderation_results` + `spam_history` / `scam_history` views.

**v2.0 Intelligence tables:** `user_profiles` (one permanent record per member —
identity, roles, permissions, avatar/banner/accent, badges, booster/timeout
status, invite attribution, `join_count`/`leave_count`/`rejoin_count`,
`imported`, `welcome_sent`, `in_guild`, `security_notes`, `telegram_log_id`,
`collected_at`/`updated_at`/`last_seen`), `profile_history` (append-only field
changes), `member_events` (join/leave/rejoin/import/kick/ban lifecycle log),
`connected_accounts` (forward-compat, official-API only), `intel_scan_state`
(first-run scan bookkeeping), `warning_settings` (3-level system config) and
`mod_actions` (moderator action audit with history snapshots).

---

## 🔒 Privacy by Design

- Detailed member info (IDs, account age, inviter, DM status, first message
  content) is delivered **only** to the owner's private Telegram chat.
- **Security incidents** (risk scores, scam evidence, spam content, raid
  summaries) also go to Telegram only — never posted publicly.
- Only uses data legitimately available via the Discord API + own stored
  history. No claims about IPs, VPNs, email/phone verification or devices.
- Public Discord channels show a clean, friendly welcome embed only.
- Telegram failures retry with backoff, honour 429 `retry_after`, are audited
  in `telegram_logs`, and **never interrupt** the Discord flow.
- DM failures are silent to users and recorded in `dm_status`.

## ⚡ Large-Server Optimizations

- `chunk_guilds_at_startup=False` — no full member scans on boot
- Fast-path rejections in `on_message` before any DB access
- Exactly-once unlock: SQLite `INSERT`-claim (unique PK) + per-user `asyncio.Lock`
- Image rendering off-loaded to a thread executor — event loop never blocks
- WAL journal mode, indexed queries, rotating log files
- Security pipeline: cheapest checks first, stop at first hit; settings cached
  per guild; in-memory sliding windows pruned every 30 s; AI checks gated by
  per-user cooldown + content-fingerprint dedupe (minimal Groq usage)
- All enforcement exception-safe: a failed action never crashes the pipeline

## 🧩 Roadmap (plug-in modules)
~~Security System~~ ✅ · ~~AI Moderation~~ ✅ · Verification · Tickets ·
Tech News · Leveling · Reputation · Analytics Dashboard · Giveaways
