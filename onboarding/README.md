# ⚡ Developer Forge — Premium Welcome & Onboarding System

A **production-ready, modular Discord onboarding bot** built with the latest
**discord.py 2.x**. New members get a premium welcome experience (embed +
generated welcome card + interactive buttons + personalized DM), while the
server owner receives **private Telegram notifications** — sensitive member
data never appears in public Discord channels.

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
    │   ├── schema.sql          # Full schema (9 tables, WAL mode)
    │   └── db.py               # Async abstraction layer (aiosqlite) — no SQL in cogs
    ├── services/
    │   ├── telegram.py         # Owner notifier: retries, 429 handling, audit log
    │   ├── invites.py          # Invite-use snapshot diffing
    │   └── welcome_image.py    # Pillow card renderer (thread-executor, non-blocking)
    ├── cogs/
    │   ├── welcome.py          # Member-join pipeline
    │   ├── activity.py         # First-message 🔥 Forge Member unlock
    │   └── admin.py            # /forge configuration dashboard
    └── utils/
        ├── embeds.py           # Premium blue-theme embed builders
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
3. Invite with permissions: `Manage Roles`, `Send Messages`, `Embed Links`,
   `Attach Files`, `Add Reactions`, `Manage Server` (for invite tracking)
4. Make sure the bot's role sits **above** the New Member / Forge Member roles.

### 2. Telegram Bot (owner notifications)
1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy token
2. Send `/start` to your new bot
3. Get your chat id: `https://api.telegram.org/bot<TOKEN>/getUpdates`

### 3. Run
```bash
cd onboarding
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in DISCORD_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
python main.py
```

### 4. Configure in Discord (admin only)
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

---

## 🗄 Data Model (key columns)

`members`: `guild_id`, `user_id`, `member_number`, `joined_at`,
`account_created_at`, `welcome_sent`, `dm_sent`, `forge_member_awarded`,
`first_message_time`, `first_message_channel`, `invite_code`, `inviter_id`,
`telegram_sent`, `telegram_status` — plus append-only `join_history`,
`invite_history`, `dm_status`, `role_rewards`, `activity_progress`,
`telegram_logs`, and per-guild `guild_settings` / `welcome_settings`.

---

## 🔒 Privacy by Design

- Detailed member info (IDs, account age, inviter, DM status, first message
  content) is delivered **only** to the owner's private Telegram chat.
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

## 🧩 Roadmap (plug-in modules)
Security System · AI Moderation · Verification · Tickets · Tech News ·
Leveling · Analytics Dashboard · Auto Moderation · Logging · Giveaways
