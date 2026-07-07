# 🚀 Deployment Guide

| Component | Platform | Why |
|---|---|---|
| `backend/` (FastAPI + Groq) | **Vercel** (serverless) | Stateless HTTP API — perfect fit for serverless |
| `bot/` (Discord.js v14) | **Wispbyte** (Node.js server) | Discord bots need a 24/7 persistent gateway connection |
| `onboarding/` (discord.py) | **Wispbyte** (Python server) | Same — long-running process + local SQLite storage |

> ⚠️ Discord bots can NEVER run on serverless platforms (Vercel/Cloudflare) —
> they hold a persistent WebSocket connection to the Discord gateway.

---

## 1️⃣ Backend → Vercel

The backend ships with everything Vercel needs:

```
backend/
├── api/index.py     # Vercel ASGI entry point (exports the FastAPI app)
├── vercel.json      # Rewrites all routes → /api/index, 30s max duration
├── .vercelignore    # Excludes .env, venv, caches
└── requirements.txt # Auto-installed by Vercel's Python runtime
```

### Deploy via Vercel Dashboard (recommended)
1. Go to <https://vercel.com/new> → **Import** the `Welcome-Bot` GitHub repo.
2. Set **Root Directory** to `backend` ← important!
3. Framework preset: **Other** (auto-detected Python).
4. Add Environment Variables:
   | Name | Value |
   |---|---|
   | `GROQ_API_KEY` | your key from <https://console.groq.com/keys> |
   | `GROQ_MODEL` | `llama-3.3-70b-versatile` (optional) |
   | `MIN_CONFIDENCE` | `0.5` (optional) |
   | `LOG_LEVEL` | `INFO` (optional) |
5. Click **Deploy**.

### Deploy via CLI
```bash
npm i -g vercel
cd backend
vercel --prod
# add secrets once:
vercel env add GROQ_API_KEY production
```

### Verify
```bash
curl https://<your-project>.vercel.app/health
curl https://<your-project>.vercel.app/          # service metadata
```

Your AI backend URL is now: `https://<your-project>.vercel.app`

---

## 2️⃣ Discord.js Bot (`bot/`) → Wispbyte

Wispbyte runs a Pterodactyl-style panel. Create a **Node.js** server.

### Steps
1. Sign up / log in at <https://wispbyte.com> and create a **Node.js** server
   (Node **18+**).
2. Upload the contents of the `bot/` folder (or clone via the panel's Git
   feature if available):
   - Zip locally: `cd bot && zip -r bot.zip . -x "node_modules/*" ".env"`
   - Upload + extract via the panel **Files** tab.
3. **Startup configuration** (panel → Startup tab):
   - Main / startup file: `src/index.js`
   - The Node egg auto-runs `npm install` when `package.json` is present.
     If not, run it once in the panel **Console**: `npm install`
4. **Environment variables** — either use the panel's Variables tab or
   create a `.env` file in the Files tab (copy from `.env.example`):
   ```env
   DISCORD_TOKEN=your-bot-token
   CLIENT_ID=your-application-client-id
   GUILD_ID=your-guild-id
   WELCOME_CHANNEL_ID=...
   GOODBYE_CHANNEL_ID=...
   LOG_CHANNEL_ID=...
   EXPLORER_ROLE_ID=...
   # 👇 point at your deployed Vercel backend
   AI_BACKEND_URL=https://<your-project>.vercel.app
   AI_REQUEST_TIMEOUT_MS=8000
   ```
5. Register slash commands once (panel Console):
   ```bash
   npm run deploy
   ```
6. **Start** the server. Console should show the bot logging in.

---

## 3️⃣ Onboarding Bot (`onboarding/`) → Wispbyte

Create a second Wispbyte server using the **Python** egg (Python **3.11+**).

### Steps
1. Create a **Python** server on Wispbyte.
2. Upload the contents of the `onboarding/` folder:
   - Zip locally: `cd onboarding && zip -r onboarding.zip . -x "__pycache__/*" ".env" "data/*" "logs/*"`
   - Upload + extract via the panel **Files** tab.
3. **Startup configuration**:
   - App py file / startup file: `main.py`
   - Requirements file: `requirements.txt` (the Python egg auto-installs it;
     otherwise run in Console: `pip install -r requirements.txt`)
4. Create `.env` in the Files tab (copy from `.env.example`):
   ```env
   DISCORD_TOKEN=your-discord-bot-token
   TELEGRAM_BOT_TOKEN=your-telegram-bot-token
   TELEGRAM_CHAT_ID=your-telegram-chat-id
   DATABASE_PATH=data/developer_forge.db
   LOG_LEVEL=INFO
   ```
5. **Start** the server. The SQLite database and logs are created
   automatically in `data/` and `logs/` (both persist on the server disk).

> 💡 Both bots can also run on any VPS / Railway / Pterodactyl host with the
> same start commands: `npm start` (bot) and `python main.py` (onboarding).

---

## 🔗 Wiring It Together

```
┌────────────┐   HTTPS    ┌──────────────────────┐
│  bot/ (JS) │ ─────────► │ backend/ on Vercel   │
│  Wispbyte  │ /moderate  │ FastAPI + Groq       │
└────────────┘            └──────────────────────┘
┌──────────────────┐  Telegram Bot API  ┌───────────────┐
│ onboarding/ (py) │ ─────────────────► │ Owner's phone │
│    Wispbyte      │                    └───────────────┘
└──────────────────┘
```

- Set `AI_BACKEND_URL` in the JS bot's env to your Vercel URL.
- The onboarding bot is fully standalone (SQLite + Telegram, no backend needed).

## ✅ Post-Deploy Checklist
- [ ] `curl https://<project>.vercel.app/health` returns 200
- [ ] JS bot online in Discord, `/warn` commands registered
- [ ] Onboarding bot online, `/forge settings` responds
- [ ] v2.0: Telegram received the "Initial Member Scan Complete" report
- [ ] v2.0: `/warn config` + `/intel stats` respond (slash commands synced)
- [ ] Test a member join → welcome embed + card + Telegram notification
- [ ] First message in #chill-zone → 🔥 Forge Member awarded
