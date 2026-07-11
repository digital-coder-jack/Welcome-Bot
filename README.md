# Discord Welcome, AI Moderation & Telegram Notification System

A production-ready Discord bot that welcomes new members with a **premium,
themed, cinematic welcome experience**, enforces server rules with layered
auto-moderation, uses an **AI backend (FastAPI + Groq)** to detect nuanced
abuse, and relays **every notable event to Telegram** through a single
FastAPI backend.

> 🔒 **Core policy: the bot NEVER kicks or bans automatically.** Reaching the
> warning threshold (or a critical-severity warning) raises a **Moderator
> Approval Panel** — a human moderator must explicitly approve any punishment,
> and kicks/bans additionally require a **confirmation step**. The server
> owner can override/cancel any pending punishment.

## Project Overview

- **Name**: welcome-bot
- **Goal**: One Discord.js bot + one FastAPI backend that together provide the
  complete welcome, moderation, security and Telegram-notification pipeline.
- **Architecture**:

```
Discord Bot (bot/, Discord.js v14 — Wispbyte)
        │ HTTPS (fetch)
        ▼
FastAPI Backend (backend/ — Vercel)  ←  the SINGLE API
        │ Telegram Bot API (httpx)
        ▼
Telegram (owner notifications)
```

| Service      | Stack                                    | Responsibility |
|--------------|------------------------------------------|----------------|
| **bot/**     | Node.js · Discord.js v14 · ES Modules    | Discord client: welcome system, warnings, auto-mod, invite tracking, security detection |
| **backend/** | Python 3.12+ · FastAPI · Groq · httpx    | AI moderation (`/moderate`), health (`/health`), **all Telegram notifications** (`/telegram/*`) |

> ⚠️ **`onboarding/` is DEPRECATED** and must not be deployed. All of its
> Telegram/security features were migrated into `backend/` + `bot/`.
> See [`onboarding/DEPRECATED.md`](onboarding/DEPRECATED.md).

## Backend API

| Method | Path                        | Purpose |
|--------|-----------------------------|---------|
| POST   | `/moderate`                 | AI moderation analysis (Groq, heuristic fallback) — **unchanged** |
| GET    | `/health`                   | Liveness probe + Groq/Telegram config status — **unchanged path** |
| POST   | `/telegram/member-joined`   | Full join intelligence report → Telegram |
| POST   | `/telegram/member-left`     | Departure notification → Telegram |
| POST   | `/telegram/warning`         | Warning issued → Telegram |
| POST   | `/telegram/kick`            | Member kicked → Telegram |
| POST   | `/telegram/ban`             | Member banned → Telegram |
| POST   | `/telegram/security-alert`  | Raid / scam / AI-violation alerts → Telegram |
| POST   | `/security/analyze-join`    | 🆕 **Guardian v2.0** — AI join analysis (risk score, threat level, confidence, reasons, recommended action) |
| POST   | `/security/analyze-event`   | 🆕 **Guardian v2.0** — AI analysis of suspicious live events (scams, token leaks, ...) |
| POST   | `/telegram/timeout`         | 🆕 Member timed out → Telegram |
| POST   | `/telegram/high-risk-join`  | 🆕 Rich high-risk-join report → Telegram |
| POST   | `/telegram/owner-approval`  | 🆕 Owner Approval Request → Telegram |

The join notification includes: Username, Display Name, User ID, Server Name,
Join Time, Account Created, Account Age, Member Number, Invite Code, Inviter,
Bot or Human, Avatar URL (sent as photo), Assigned Role, DM Status, and the
Server Invite Used.

## Premium Welcome System (on member join)

1. **Cinematic public welcome** — a 5-frame "video-style" animation (loading
   frames → final premium embed) with themed GIF, decorative emojis, avatar,
   server icon, member count, account age, join timestamp, emoji bursts,
   guild stickers (when available) and clickable buttons
   (📖 Rules · 💬 Introduce Yourself · 🎮 Community · 🌐 Website).
2. **Premium welcome DM** — a multi-embed journey: hero embed with animated
   GIF + personalised greeting, a "what to do next" section with its own GIF,
   the server rules, and a button row (📖 Rules · 🛟 Support · 🎮 Community · 🌐 Website).
3. **Forge Member** role auto-assigned
4. Developer Intro message auto-sent to the dev-intro channel
5. Telegram join notification via the backend
6. Member information saved to the local member store

Plus: raid detection (8+ joins/60s) and new-account screening (<7 days) fire
`/telegram/security-alert` automatically.

### 🎨 Welcome Themes (8)

`Cyber Blue` · `Discord Purple` · `Galaxy` · `Dark Neon` · `Developer` · `AI`
· `Minimal` · `Space` — each theme changes embed colours, the GIF collection
(5 GIFs per theme, random selection with **no consecutive repeats**), emoji
style, dividers and button emojis. Admins pick a theme with
`/welcomeconfig theme`, and can override the GIF pool with their own
collection via `/welcomeconfig gifs add`.

## 🛡️ Forge Guardian Security System v2.0

Enterprise-grade, fully modular security layered ON TOP of every existing
feature (welcome system, Developer Intro, Forge Member role, warnings, AI
moderation and DM system all continue working unchanged). Every phase fails
safely and is configurable via environment variables.

### Phase 1 — Join Security Scan (`bot/src/security/joinScan.js`)

Every join triggers a complete scan:

- **Identity Analysis** (`identityAnalyzer.js`) — username, global display
  name, server nickname: invisible Unicode, zero-width characters, homoglyph
  attacks, emoji abuse, scam keywords, fake Staff/Moderator/Admin/Discord
  Employee impersonation.
- **Account Analysis** (`accountAnalyzer.js`) — account age & days since
  creation, new/recently-created account detection, default avatar detection,
  bot-or-human, plus (when available) banner URL, accent color, avatar
  decoration, public badges & public flags.
- **Invite Tracking** — invite code, inviter, uses, vanity & unknown-invite
  detection (existing inviteTracker, now feeding the risk engine).
- **Previous History** (`database/securityStore.js`) — our own database:
  previous joins/leaves/warnings/timeouts/kicks/bans, previous risk scores
  and rejoin count (`security-history.json`).
- **AI Join Analysis** — the complete member profile goes to FastAPI;
  Groq returns **Risk Score (0–100), Threat Level, Confidence, Reasons and a
  Recommended Action**.

**Risk classification:** `0–20 SAFE · 21–40 LOW · 41–60 REVIEW · 61–80 HIGH ·
81–100 CRITICAL`

### Phase 2 — Live Security (`liveSecurity.js` + `threatDetectors.js`)

Every message is monitored. On top of the existing filters (spam, flooding,
emoji/mention spam, CAPS, invites, repeats) v2.0 adds: scam links, malware
domains, phishing URLs, fake Nitro, crypto scams, fake giveaways, Discord
invite spam, link spam, channel spam (cross-posting), Unicode abuse,
invisible characters, token leaks and mass copy-paste. Every suspicious
message is also analyzed by Groq AI.

### Phase 3 — Anti Raid (`raidManager.js`)

Detects raids (default: **10 joins within 30 seconds**) and enables
**Raid Mode**: pauses welcomes, locks the configured channels, enables
slowmode, restricts (timeouts) suspicious new accounts, notifies the owner +
moderators in Discord and sends a Telegram alert. Raid Mode auto-disables
after the configured timeout and restores all channels.

### Phase 4 — AI Security Engine (`backend/app/routes/security.py`)

Every suspicious event goes through FastAPI. Groq returns Threat Level,
Confidence, Explanation, Violated Rule and a Recommended Action
(`ignore / delete_message / warn / timeout / kick / ban_recommendation`).
**The AI can NEVER ban automatically** — the strongest thing it can produce is
a recommendation that raises a human-approval alert.

### Phase 5 — Owner Approval System (`securityAlerts.js`)

HIGH/CRITICAL threats create a **Security Alert** card with buttons:

✅ Ban · ⚠ Kick · 🟡 Timeout · 📝 Warn · ❌ Ignore

Only the **Owner, Administrators or configured Moderator roles** can press
them (Ban/Kick also require the matching Discord permission). Duplicate-click
locks, disabled buttons after resolution, full audit + Telegram trail.

### Security Report (`securityReport.js`)

After every successful join a rich report is posted showing: Scan Progress,
Risk Score, Threat Level, Username Check, Account Age Check, Avatar Check,
Invite Check, AI Analysis, Scam Detection, Role Assignment, Welcome DM Status,
Developer Intro Status, Forge Member Role Status, Telegram Status, Database
Status and Scan Time.

### Telegram Notifications (rich HTML, owner-only)

New Member · High Risk Join · Scam Detection · Warning · Timeout · Kick · Ban
· Raid Detection · Dangerous Username · Owner Approval Request — all relayed
through the FastAPI backend (the bot never talks to Telegram directly).

### Phase 6 — Security Dashboard (`commands/security.js`) 🆕

`/security dashboard` shows: Protected Members · Threats Blocked · Spam
Blocked · Warnings Today · Total Warnings · Timeouts · Kicks · Bans · Scam
Attempts · Raid Attempts · Current Risk · AI Status · Telegram Status ·
Database Status · Bot Status · Average Scan Time · Server Security Rating
(A+…F grade).

| Subcommand | Purpose |
|---|---|
| `/security dashboard` | Full security dashboard |
| `/security member <user>` | Permanent member security profile (Phase 7) |
| `/security server` | Server-wide security overview |
| `/security scan <user>` | On-demand security scan (risk score + findings) |
| `/security logs [count]` | Recent security event log (rolling, 200 kept) |
| `/security raid [status\|activate\|deactivate]` | Raid Mode status & manual control |
| `/security lockdown [reason]` | Manual lockdown (locks channels, pauses welcomes) |
| `/security unlock` | Lift the manual lockdown |
| `/security whitelist add/remove/view` | Users bypassing live security |
| `/security blacklist add/remove/view` | Own user / invite / server blacklists |
| `/security risk` | Current server risk assessment |
| `/security settings` | Effective security settings |
| `/security export` | Export all security data as JSON |

Supporting modules: `security/lockdownManager.js` (manual lockdown),
`security/securityLogger.js` (durable event log + optional
`SECURITY_LOG_CHANNEL_ID` / `AI_ANALYSIS_CHANNEL_ID` mirroring),
`database/statsStore.js` (all dashboard counters + daily buckets + average
scan time + security rating).

### Phase 7 — Permanent Member Security Profile (`database/profileStore.js`) 🆕

Every member gets a durable, structured profile built ONLY from Bot-API data
and internal records:

- **Identity** — username, display name, nickname, user ID, avatar/banner URL,
  accent color, public flags, badges, bot/human
- **Account** — account created, joined server, account age, member number
- **Server** — roles, highest role, invite used, inviter, verification status,
  Forge Member status, Developer Intro status, Welcome DM status
- **Moderation** — warnings, timeouts, kicks, bans, deleted messages, AI violations
- **Security** — risk score, threat level, scam detections, suspicious
  username/avatar, previous joins/leaves, rejoin count, reputation
- **Activity** — message count, voice minutes (`events/voiceStateUpdate.js`),
  attachments sent, links shared, last seen (`events/messageActivity.js`)

> **Privacy guarantee:** we never collect (or claim to collect) user bios,
> connected accounts, other servers, emails, phone numbers, IPs, browsers,
> devices, locations or Nitro status — Discord's Bot API does not expose them.

### Phase 8 — Advanced Protection (`security/advancedProtection.js`) 🆕

Heuristics-only detectors (Bot-API data + internal records, merged into the
join-scan risk score):

- Alt account detection (age + default avatar + numeric-suffix name + rejoin history)
- Invite farming detection (one inviter bringing many new accounts per hour)
- Fake Staff & fake Discord Employee detection (impersonation name patterns)
- Mass account creation detection (joiners with accounts created minutes apart)
- Rejoin abuse detection (join/leave cycling)
- Role & permission abuse watchdog (`events/guildMemberUpdate.js` — rapid role
  grants / dangerous permissions gained; alerts only, never auto-reverts)
- Blacklisted user / invite / server databases (`database/blacklistStore.js`;
  blacklisted invite links posted in chat are auto-deleted)
- Reputation score (0–100) computed from THIS server's activity only

## 🛡️ Security & Moderation Workflow

**Smart warning levels** — every warning is classified
🟢 Low / 🟡 Medium / 🟠 High / 🔴 Critical (auto-classified from the reason,
or set explicitly via `/warn severity:`). Critical never triggers automatic
punishment — it raises an **urgent** moderation alert immediately.

**Warning ladder (DMs to the user):**

| Warning | User receives |
|---|---|
| 1 | 💛 Friendly reminder |
| 2 | ⚠️ Serious warning |
| 3 (threshold) | 🚨 Final notice — case forwarded to human moderators. **No auto-punishment.** |

**Moderator Approval Panel** (posted to the alert channel at the threshold):
shows avatar, username, user ID, account age, join date, reason, warning
history, **risk score (0–100)** and recent violations, with buttons:

✅ Ignore · ⚠️ Reset Warnings · 🕒 Timeout · 🔇 Mute · 👢 Kick · 🔨 Ban · 📄 View History

- Only configured moderator roles / members with Moderate Members can act.
- **Kick/Ban open a confirmation prompt** (✅ Confirm / ❌ Cancel) — nothing
  executes until explicitly confirmed.
- **Owner override**: the server owner (or configured owner role) can cancel
  any pending punishment, reset warnings, or reduce to timeout/mute.
- **Anti-abuse**: per-case processing locks, one open case per member,
  single state transitions (double-click/duplicate-moderator safe), buttons
  disabled after resolution, per-button permission checks.
- **Audit trail**: every panel action, confirmation, override and executed
  punishment is logged with moderator, timestamp, reason, old → new warning
  counts, button pressed, confirmation status, channel, message link and a
  unique `AUD-XXXXXXXX` audit trail ID (persisted to `audit.json` + posted
  to the log channel).

### ⚙️ Configuration Dashboard (slash commands)

| Command | Purpose |
|---|---|
| `/welcomeconfig view` | Show welcome settings |
| `/welcomeconfig theme <theme>` | Pick one of the 8 themes |
| `/welcomeconfig toggles public/dm/animated/random_gif` | Enable/disable features |
| `/welcomeconfig website <url\|clear>` | Set the 🌐 Website button |
| `/welcomeconfig gifs add/clear` | Manage the custom GIF collection |
| `/securityconfig view` | Show security settings |
| `/securityconfig alertchannel <#channel>` | Dedicated moderation-alert channel |
| `/securityconfig ownerrole <role>` | Owner-override role |
| `/securityconfig modroles add/remove <role>` | Approval-panel moderator roles |
| `/securityconfig thresholds warnings/timeout_minutes` | Warning threshold & timeout duration |
| `/security …` | 🆕 Full Security Dashboard — see Phase 6 table above |

## Folder Structure

```
welcome-bot/
├── bot/                          # Discord.js v14 client (Wispbyte)
│   └── src/
│       ├── commands/             # /warn /warnings /clearwarnings /kick /ban /welcomeconfig /securityconfig + deploy script
│       ├── events/               # ready, guildMemberAdd/Remove, guildBanAdd, inviteCreate/Delete, messageCreate, interactionCreate
│       ├── handlers/             # dynamic event & command loaders
│       ├── managers/             # ⭐ NEW modular managers:
│       │   ├── welcomeManager.js     #   premium public welcome + cinematic animation + buttons
│       │   ├── dmManager.js          #   premium multi-embed welcome DM
│       │   ├── themeManager.js       #   8 welcome themes (colors, GIFs, emojis)
│       │   ├── gifManager.js         #   animated asset manager, random no-repeat GIFs, stickers
│       │   ├── warningManager.js     #   smart severity levels + risk scoring
│       │   ├── moderationQueue.js    #   pending cases, locks, race-condition safety
│       │   ├── approvalSystem.js     #   moderator panel, confirmations, owner override
│       │   └── auditLogger.js        #   audit-trail IDs + rich moderation logs
│       ├── security/             # 🆕 Forge Guardian Security System v2.0:
│       │   ├── identityAnalyzer.js   #   Phase 1: names, unicode, homoglyphs, scam keywords, impersonation
│       │   ├── accountAnalyzer.js    #   Phase 1: age, avatar, banner, badges, flags
│       │   ├── riskEngine.js         #   0–100 risk scoring + SAFE…CRITICAL classification
│       │   ├── joinScan.js           #   Phase 1: complete join-scan orchestrator
│       │   ├── threatDetectors.js    #   Phase 2: scams, phishing, token leaks, copy-paste, channel spam
│       │   ├── liveSecurity.js       #   Phase 2: live message pipeline + AI verdicts
│       │   ├── raidManager.js        #   Phase 3: raid detection + Raid Mode (auto-expiring)
│       │   ├── securityAlerts.js     #   Phase 5: Owner Approval buttons (Ban/Kick/Timeout/Warn/Ignore)
│       │   └── securityReport.js     #   post-join Security Report embed
│       ├── services/             # aiClient (+security endpoints), telegramClient (+timeout/high-risk/approval), inviteTracker, securityService, moderationService
│       ├── filters/              # rule-based auto-mod + AI pipeline orchestrator (+live security stage)
│       ├── utils/                # logger, embeds, rules, time
│       ├── database/             # jsonStore (generic), warningStore, memberStore, settingsStore, 🆕 securityStore
│       ├── client.js / config.js / index.js
│       └── ...
│
├── backend/                      # FastAPI backend (Vercel) — single API
│   ├── api/index.py              # Vercel serverless entry
│   ├── app/
│   │   ├── routes/               # moderation.py, telegram.py, health.py, 🆕 security.py
│   │   ├── services/             # groq_service.py, telegram_service.py, 🆕 security_service.py
│   │   ├── schemas/              # moderation.py, telegram.py, 🆕 security.py
│   │   ├── prompts/              # moderation system prompt, 🆕 security prompts
│   │   ├── utils/                # config.py, logger.py
│   │   └── main.py
│   ├── requirements.txt
│   └── vercel.json
│
└── onboarding/                   # ⚠️ DEPRECATED — do not deploy
```

## Environment Variables

**Backend (Vercel):**

| Var | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq API key for AI moderation |
| `GROQ_MODEL` | Model (default `llama-3.3-70b-versatile`) |
| `TELEGRAM_BOT_TOKEN` | **NEW** — Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | **NEW** — chat/channel ID that receives notifications |

**Bot (Wispbyte):**

| Var | Purpose |
|---|---|
| `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` | Discord credentials |
| `AI_BACKEND_URL` | Vercel backend URL |
| `WELCOME_CHANNEL_ID`, `GOODBYE_CHANNEL_ID`, `LOG_CHANNEL_ID` | Channels |
| `DEV_INTRO_CHANNEL_ID` | Developer Intro channel |
| `FORGE_MEMBER_ROLE_ID` | Forge Member auto-role |
| `RULES_CHANNEL_ID` | **NEW (optional)** — 📖 Rules button target |
| `COMMUNITY_CHANNEL_ID` | **NEW (optional)** — 🎮 Community button target |
| `SUPPORT_CHANNEL_ID` | **NEW (optional)** — 🛟 Support button target (DM) |
| `MOD_ALERT_CHANNEL_ID` | **NEW (optional)** — default moderation-approval-panel channel |
| `MAX_WARNINGS` | Warnings before a **moderation approval panel** is raised (default 3) — never an auto-kick |

**🆕 Forge Guardian v2.0 (all optional, safe defaults):**

| Var | Default | Purpose |
|---|---|---|
| `SECURITY_JOIN_SCAN_ENABLED` | `true` | Phase 1 join security scan |
| `SECURITY_LIVE_SCAN_ENABLED` | `true` | Phase 2 live message threat detection |
| `SECURITY_ANTI_RAID_ENABLED` | `true` | Phase 3 raid detection + Raid Mode |
| `SECURITY_AI_ANALYSIS_ENABLED` | `true` | Phase 4 Groq AI security engine |
| `SECURITY_NEW_ACCOUNT_DAYS` | `7` | Younger ⇒ "new account" |
| `SECURITY_RECENT_ACCOUNT_DAYS` | `30` | Younger ⇒ "recently created" |
| `SECURITY_RAID_JOINS` | `10` | Joins within the window that trigger Raid Mode |
| `SECURITY_RAID_WINDOW_SEC` | `30` | Raid detection rolling window (s) |
| `SECURITY_RAID_MODE_MINUTES` | `15` | Raid Mode auto-disable timeout |
| `SECURITY_RAID_SLOWMODE_SEC` | `30` | Slowmode applied during Raid Mode |
| `SECURITY_RAID_LOCK_CHANNEL_IDS` | — | Comma-separated channels to lock in Raid Mode |
| `SECURITY_ALERT_CHANNEL_ID` | — | Owner-Approval alert channel (falls back to MOD_ALERT/LOG) |
| `SECURITY_REPORT_CHANNEL_ID` | — | Security Report channel (falls back to alert channel) |
| `SECURITY_JOIN_REPORT_ENABLED` | `true` | Post the Security Report after every join |
| `SECURITY_APPROVAL_THRESHOLD` | `61` | Risk score ≥ this raises an Owner Approval alert |
| `SECURITY_TIMEOUT_MINUTES` | `60` | Duration of the 🟡 Timeout button |
| `SECURITY_LOG_CHANNEL_ID` | — | 🆕 Phase 6 — mirrored security event log channel (optional) |
| `AI_ANALYSIS_CHANNEL_ID` | — | 🆕 Phase 6 — mirrored AI analysis events channel (optional) |
| `SECURITY_DASHBOARD_CHANNEL_ID` | — | 🆕 Phase 6 — reserved dashboard channel (optional) |
| `DEVINTRO_CHANNEL_ID` | — | 🆕 Alias for `DEV_INTRO_CHANNEL_ID` (either works) |

All dedicated security channels (`SECURITY_ALERT_CHANNEL_ID`,
`SECURITY_LOG_CHANNEL_ID`, `AI_ANALYSIS_CHANNEL_ID`,
`SECURITY_DASHBOARD_CHANNEL_ID`, `WELCOME_CHANNEL_ID`, `RULES_CHANNEL_ID`,
`DEVINTRO_CHANNEL_ID`, `SUPPORT_CHANNEL_ID`) are **optional** — unset
channels are silently skipped.

Config is read **only** from environment variables.

## Deployment

| Component | Platform | Notes |
|---|---|---|
| `backend/` | **Vercel** | Root Directory = `backend`, add the 4 env vars above |
| `bot/` | **Wispbyte** (Node.js) | startup `src/index.js`, run `npm install` then `npm run deploy` once to register slash commands |

Required Discord permissions/intents: **Manage Guild** (invite tracking),
**View Audit Log** (ban attribution), **Kick/Ban Members**, and the
**Guild Members** + **Message Content** privileged intents.

## User Guide

- New members get the premium themed welcome automatically (cinematic channel
  animation + immersive DM + role + intro + Telegram).
- Moderators: `/warn` (with optional severity), `/warnings`, `/clearwarnings`,
  `/kick`, `/ban` (manual commands still work as before).
- Admins: `/welcomeconfig` and `/securityconfig` dashboards.
- At the warning threshold (or on a critical warning) a **Moderator Approval
  Panel** appears in the alert channel — moderators choose the outcome;
  kick/ban require confirmation; the owner can override.
- Every warning, panel action and security event lands in the moderation log
  (with audit-trail IDs) and your Telegram chat.
- AI moderation flags toxic messages automatically; violations are deleted
  and warned — an AI "kick" verdict becomes a HIGH-severity warning that
  escalates to the human approval panel, never a direct kick.

## Data Stores (file-backed JSON, zero external DB)

| File | Contents |
|---|---|
| `warnings.json` | Warning records (now with `[SEVERITY]` prefixes) |
| `members.json` | Member join intelligence |
| `settings.json` | Per-guild welcome + security configuration |
| `modqueue.json` | Pending/resolved moderation cases |
| `audit.json` | Append-only audit trail (last 2000 entries per guild) |
| `security-history.json` | 🆕 Guardian v2.0 per-member security history (joins, leaves, warnings, timeouts, kicks, bans, risk scores, rejoin count) |
| `security-stats.json` | 🆕 Phase 6 — guild security statistics (dashboard counters, daily buckets, scan times) |
| `member-profiles.json` | 🆕 Phase 7 — permanent member security profiles (identity/account/server/moderation/security/activity) |
| `security-lists.json` | 🆕 Phase 8 — blacklists (users/invites/servers) + whitelist |
| `security-log.json` | 🆕 Phase 6 — rolling security event log (200 events per guild) |

## Deployment Status

- **Tech Stack**: Discord.js v14 + FastAPI + Groq + Telegram Bot API
- **Backend Version**: 2.0.0 · **Bot Version**: 2.0.0 (premium welcome + approval-panel security + **Forge Guardian Security System v2.0**)
- **Last Updated**: 2026-07-10
