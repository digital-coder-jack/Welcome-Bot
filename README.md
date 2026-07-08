# Discord Welcome, AI Moderation & Telegram Notification System

A production-ready Discord bot that welcomes new members, enforces server rules
with layered auto-moderation, uses an **AI backend (FastAPI + Groq)** to detect
nuanced abuse, and relays **every notable event to Telegram** (joins, leaves,
warnings, kicks, bans, security alerts) through a single FastAPI backend.

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

## Welcome System (on member join)

1. Welcome embed in the welcome channel
2. Animated welcome DM (GIF banner) + server rules DM
3. **Forge Member** role auto-assigned
4. Developer Intro message auto-sent to the dev-intro channel
5. Telegram join notification via the backend
6. Member information saved to the local member store

Plus: raid detection (8+ joins/60s) and new-account screening (<7 days) fire
`/telegram/security-alert` automatically.

## Folder Structure

```
welcome-bot/
├── bot/                          # Discord.js v14 client (Wispbyte)
│   └── src/
│       ├── commands/             # /warn /warnings /clearwarnings /kick /ban + deploy script
│       ├── events/               # ready, guildMemberAdd/Remove, guildBanAdd, inviteCreate/Delete, messageCreate, interactionCreate
│       ├── handlers/             # dynamic event & command loaders
│       ├── services/             # aiClient, telegramClient, inviteTracker, securityService, moderationService
│       ├── filters/              # rule-based auto-mod + AI pipeline orchestrator
│       ├── utils/                # logger, embeds, rules, time
│       ├── database/             # warningStore + memberStore (file-backed JSON)
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
| `DEV_INTRO_CHANNEL_ID` | **NEW** — Developer Intro channel |
| `FORGE_MEMBER_ROLE_ID` | Forge Member auto-role |
| `MAX_WARNINGS` | Warnings before auto-kick (default 3) |

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

- New members are welcomed automatically (embed + DM + role + intro + Telegram).
- Moderators: `/warn`, `/warnings`, `/clearwarnings`, `/kick`, `/ban`.
- Every warning/kick/ban and security event lands in your Telegram chat.
- AI moderation flags toxic messages automatically; high-confidence violations
  are deleted, warned, and reported to Telegram as security alerts.

## Deployment Status

- **Tech Stack**: Discord.js v14 + FastAPI + Groq + Telegram Bot API
- **Backend Version**: 2.0.0
- **Last Updated**: 2026-07-08
