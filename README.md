# Discord Welcome & AI Moderation Bot

A production-ready Discord bot that welcomes new members, enforces server rules
with layered auto-moderation, and uses an **AI backend (FastAPI + Groq)** to
detect nuanced abuse such as toxicity, harassment, hate speech, threats and
personal attacks.

The project is split into independent services:

| Service        | Stack                                     | Responsibility                                  |
|----------------|-------------------------------------------|--------------------------------------------------|
| **bot/**       | Node.js · Discord.js v14 · ES Modules     | Discord client, welcome/goodbye, warnings, auto-mod |
| **backend/**   | Python 3.12+ · FastAPI · Groq · Pydantic  | AI message analysis (`/moderate`, `/health`)    |
| **onboarding/**| Python 3.12+ · discord.py 2.x · aiosqlite · Pillow | ⚡ **Developer Forge premium Welcome & Onboarding System v2.0** — welcome embeds + generated welcome cards, **premium multi-embed welcome DM with animated GIF banner & buttons**, auto roles, invite tracking, first-message 🔥 Forge Member unlock, **3-level warning system (reminder → official warning → auto kick/ban)**, **member intelligence database with existing-members scan, change history & join/leave/rejoin tracking**, private **Telegram security logs**, `/forge` `/security` `/warn` `/intel` dashboards. See [`onboarding/README.md`](onboarding/README.md). |

The bot talks to the backend **only** through two HTTP endpoints, keeping the
two halves cleanly decoupled.

## 🚀 Deployment

| Component | Platform | Config |
|---|---|---|
| `backend/` | **Vercel** (serverless) | `backend/vercel.json` + `backend/api/index.py` — set Root Directory to `backend`, add `GROQ_API_KEY` env var |
| `bot/` | **Wispbyte** (Node.js egg) | startup file `src/index.js`, point `AI_BACKEND_URL` to your Vercel URL |
| `onboarding/` | **Wispbyte** (Python egg) | startup file `main.py` |

📖 **Full step-by-step instructions: [`DEPLOYMENT.md`](DEPLOYMENT.md)**

---

## Architecture

```
welcome-bot/
├── bot/                         # Discord.js v14 client (Node, ES Modules)
│   ├── src/
│   │   ├── commands/            # /warn, /warnings, /clearwarnings + deploy script
│   │   ├── events/             # ready, guildMemberAdd/Remove, messageCreate, interactionCreate
│   │   ├── handlers/           # dynamic event & command loaders
│   │   ├── services/           # aiClient (HTTP -> backend), moderationService (engine)
│   │   ├── filters/            # rule-based auto-mod + pipeline orchestrator
│   │   ├── utils/              # logger, embeds, rules
│   │   ├── database/           # file-backed warning store
│   │   ├── client.js           # Discord client factory (intents/partials)
│   │   ├── config.js           # env loading + validation + SERVER_RULES
│   │   └── index.js            # entry point / bootstrap
│   ├── package.json
│   ├── .env(.example)
│   └── .gitignore
│
├── backend/                     # FastAPI + Groq AI moderation service
│   ├── app/
│   │   ├── routes/             # /moderate, /health
│   │   ├── services/           # groq_service (Groq call + validation + fallback)
│   │   ├── schemas/            # Pydantic request/response models
│   │   ├── prompts/            # moderation system prompt (rules + JSON contract)
│   │   ├── utils/              # config (pydantic-settings) + logger
│   │   └── main.py             # FastAPI app factory
│   ├── requirements.txt
│   ├── .env(.example)
│   └── .gitignore
│
└── README.md
```

---

## Features

### Welcome System (`events/guildMemberAdd.js`)
- Sends a welcome **embed** to the welcome channel.
- Automatically assigns the **Explorer** role.
- **DMs the server rules** to the new member.
- Logs the join (with account-age hint) to the log channel.

### Goodbye System (`events/guildMemberRemove.js`)
- Sends a goodbye message to the goodbye channel.
- Logs the departure.

### Warning System (slash commands)
- `/warn <user> [reason] [rule]` — issue a warning (persisted, DM'd, logged).
- `/warnings <user>` — list a user's warnings.
- `/clearwarnings <user>` — clear all warnings (elevated permission).
- Maximum **3 warnings** (configurable) → user is **automatically kicked**.
- Every action is logged.

### Auto-Moderation (`filters/`)
Fast, local, zero-cost detection for:
- **Spam / flooding** (too many messages in a time window) → Rule 4
- **Repeated messages** (same content repeated) → Rule 4
- **Invite links** → Rule 8
- **Excessive mentions** → Rule 4
- **Emoji spam** → Rule 4
- **Caps spam** → Rule 4

Violating messages are deleted and logged.

### AI Moderation (`filters/autoModerator.js` → `backend`)
Messages that pass the local filters are sent to the FastAPI backend, which uses
Groq to detect **toxicity, harassment, hate speech, personal attacks, threats**
and other rule violations. The backend returns a decision and the bot acts on it
(delete / warn, with warnings auto-escalating to a kick).

---

## Server Rules

| # | Rule |
|---|------|
| 1 | Be Respectful |
| 2 | No Hate Speech |
| 3 | Keep It Appropriate |
| 4 | No Spamming |
| 5 | Use Channels Correctly |
| 6 | No Toxic Behavior |
| 7 | Respect Privacy |
| 8 | No Advertising |
| 9 | Follow Discord Terms of Service |
| 10 | Listen to Staff |

Moderation decisions reference these numbers (kept in sync between
`bot/src/config.js` and `backend/app/prompts/moderation_prompt.py`).

---

## API Design (backend)

The bot communicates with the backend **only** via these endpoints:

### `POST /moderate`
Request:
```json
{ "content": "message text", "author_id": "123", "channel_id": "456" }
```
Response:
```json
{
  "violation": true,
  "rule": 6,
  "confidence": 0.97,
  "reason": "Personal attack",
  "action": "warn"
}
```
`action` is one of `none` | `delete` | `warn` | `kick`.

### `GET /health`
```json
{ "status": "ok", "groq_configured": true, "model": "llama-3.3-70b-versatile" }
```

Interactive docs are available at `http://localhost:8000/docs`.

---

## Setup & Run

### 1. AI Backend (start this first)

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate     # optional but recommended
pip install -r requirements.txt
cp .env.example .env                                    # then add your GROQ_API_KEY
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

> Without a `GROQ_API_KEY` the backend still runs and uses a conservative
> keyword **heuristic fallback**, so you can develop the bot without AI credits.

### 2. Discord Bot

```bash
cd bot
npm install
cp .env.example .env        # fill in DISCORD_TOKEN, CLIENT_ID, channel/role IDs
npm run deploy              # register slash commands (uses GUILD_ID if set)
npm start                  # start the bot
```

### Required Discord setup
- In the **Developer Portal → Bot → Privileged Gateway Intents**, enable
  **Server Members Intent** and **Message Content Intent**.
- Invite the bot with the `bot` + `applications.commands` scopes and the
  `Kick Members`, `Manage Messages`, `Manage Roles`, `Moderate Members` permissions.

---

## Configuration Reference

### Bot (`bot/.env`)
| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token (required) |
| `CLIENT_ID` | Application client ID (required) |
| `GUILD_ID` | Dev guild for instant command registration (optional) |
| `WELCOME_CHANNEL_ID` / `GOODBYE_CHANNEL_ID` / `LOG_CHANNEL_ID` | Channel IDs |
| `EXPLORER_ROLE_ID` | Role auto-assigned on join |
| `AI_BACKEND_URL` | FastAPI base URL (default `http://127.0.0.1:8000`) |
| `MAX_WARNINGS` | Warnings before auto-kick (default 3) |
| `SPAM_MESSAGE_LIMIT`, `SPAM_TIME_WINDOW_MS`, `MAX_MENTIONS`, `MAX_EMOJIS`, `CAPS_PERCENT_THRESHOLD`, `CAPS_MIN_LENGTH` | Auto-mod tuning |

### Backend (`backend/.env`)
| Variable | Description |
|----------|-------------|
| `GROQ_API_KEY` | Groq API key (falls back to heuristic if absent) |
| `GROQ_MODEL` | Groq model (default `llama-3.3-70b-versatile`) |
| `HOST` / `PORT` | Bind address / port |
| `MIN_CONFIDENCE` | Violations below this confidence are ignored |
| `ALLOWED_ORIGINS` | CORS origins |
| `LOG_LEVEL` | Logging level |

---

## Data & Storage

- **Warnings** are persisted by `bot/src/database/warningStore.js` to a local
  JSON file (`bot/src/database/data/warnings.json`, git-ignored) using atomic,
  debounced writes. The store's promise-based API (`addWarning`, `getWarnings`,
  `countWarnings`, `clearWarnings`) can be swapped for SQLite/Postgres without
  changing any callers.
- **Spam/repeat tracking** is kept in-memory with a sliding time window.

---

## Design Highlights

- **Fail-open AI client**: if the backend is down or slow, the bot logs a
  warning and continues — local filters still protect the server.
- **Single moderation engine**: commands, auto-mod and AI all route through
  `moderationService`, so DMs, logging and kick-escalation behave identically.
- **Dynamic loaders**: drop a new file into `events/` or `commands/` and it's
  picked up automatically — no manual wiring.
- **Strict AI contract**: Groq is called in JSON mode with `temperature=0`, and
  every field is re-validated server-side before reaching the bot.

---

## Tech Stack
- **Bot**: Node.js, Discord.js v14, dotenv, undici, ES Modules
- **Backend**: Python 3.12+, FastAPI, Uvicorn, Groq, Pydantic / pydantic-settings

## License
MIT — see [LICENSE](LICENSE).
