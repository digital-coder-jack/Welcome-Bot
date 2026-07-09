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
│       ├── services/             # aiClient, telegramClient, inviteTracker, securityService, moderationService
│       ├── filters/              # rule-based auto-mod + AI pipeline orchestrator
│       ├── utils/                # logger, embeds, rules, time
│       ├── database/             # jsonStore (generic), warningStore, memberStore, settingsStore
│       ├── client.js / config.js / index.js
│       └── ...
│
├── backend/                      # FastAPI backend (Vercel) — single API
│   ├── api/index.py              # Vercel serverless entry
│   ├── app/
│   │   ├── routes/               # moderation.py, telegram.py, health.py
│   │   ├── services/             # groq_service.py, telegram_service.py
│   │   ├── schemas/              # moderation.py, telegram.py
│   │   ├── prompts/              # moderation system prompt
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

## Deployment Status

- **Tech Stack**: Discord.js v14 + FastAPI + Groq + Telegram Bot API
- **Backend Version**: 2.0.0 · **Bot Version**: 2.0.0 (premium welcome + approval-panel security)
- **Last Updated**: 2026-07-09
