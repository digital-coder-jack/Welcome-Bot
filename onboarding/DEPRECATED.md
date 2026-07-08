# ⚠️ DEPRECATED — DO NOT USE

This `onboarding/` folder is **no longer part of the project** and must not
be deployed or run.

## What replaced it

Every feature that lived here has been migrated:

| Old (onboarding, discord.py)              | New location                                             |
|--------------------------------------------|----------------------------------------------------------|
| Telegram notifications (`services/telegram.py`) | `backend/app/services/telegram_service.py` (FastAPI)  |
| Member join pipeline (`cogs/welcome.py`)   | `bot/src/events/guildMemberAdd.js` (Discord.js v14)      |
| Security alerts (`services/security/*`)    | `bot/src/services/securityService.js` + `POST /telegram/security-alert` |
| Warnings (`cogs/warnings3.py`)             | `bot/src/services/moderationService.js` + `POST /telegram/warning` |
| Invite tracking (`services/invites.py`)    | `bot/src/services/inviteTracker.js`                      |
| Member DB (`database/*`)                   | `bot/src/database/memberStore.js`                        |

## Current architecture

```
Discord Bot (bot/, Discord.js v14, Wispbyte)
        │ HTTPS
        ▼
FastAPI Backend (backend/, Vercel)
        │ Telegram Bot API
        ▼
Telegram (owner notifications)
```

The backend is the **single API** for AI moderation, Telegram notifications,
security alerts, join notifications and all future moderation features.

This folder is retained only for historical reference and can be deleted at
any time.
