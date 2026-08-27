# Welcome-Bot Backend

FastAPI backend for the Discord Welcome-Bot providing:
- AI-powered message moderation via Groq API
- Security analysis for member joins and suspicious events
- Telegram notifications for Discord events

## Quick Start

### 1. Install Dependencies
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your actual values:
#   - GROQ_API_KEY from https://console.groq.com/keys
#   - TELEGRAM_BOT_TOKEN from @BotFather
#   - TELEGRAM_CHAT_ID from https://api.telegram.org/bot<TOKEN>/getUpdates
```

### 3. Run Locally
```bash
python main.py
# Or with auto-reload:
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 4. Test the API
```bash
# Health check
curl http://localhost:8000/health

# Get API metadata
curl http://localhost:8000/

# Test moderation endpoint
curl -X POST http://localhost:8000/moderate \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Hey everyone, great day to learn programming!",
    "author_id": "12345",
    "context": "Previous messages here..."
  }'
```

## Deployment

### Vercel
1. Push to GitHub
2. Connect repository to Vercel
3. Set Root Directory to `backend`
4. Add environment variables (same as .env)
5. Deploy

## API Endpoints

### Health & System
- `GET /` - Service metadata
- `GET /health` - Liveness probe

### Moderation
- `POST /moderate` - Analyse a Discord message

### Security (v2.0)
- `POST /security/analyze-join` - AI join analysis
- `POST /security/analyze-event` - AI event analysis

### Telegram Notifications
- `POST /telegram/member-joined` - Member join report
- `POST /telegram/member-left` - Member leave notification
- `POST /telegram/warning` - Warning issued
- `POST /telegram/kick` - Member kicked
- `POST /telegram/ban` - Member banned
- `POST /telegram/timeout` - Member timed out (v2.0)
- `POST /telegram/security-alert` - Security alert
- `POST /telegram/high-risk-join` - High-risk join report (v2.0)
- `POST /telegram/owner-approval` - Owner approval request (v2.0)

## Architecture

```
backend/
├── api/
│   └── index.py              # Vercel serverless entry point
├── app/
│   ├── main.py               # FastAPI application factory
│   ├── routes/               # API endpoint handlers
│   │   ├── health.py         # GET /health
│   │   ├── moderation.py     # POST /moderate
│   │   ├── security.py       # POST /security/*
│   │   └── telegram.py       # POST /telegram/*
│   ├── services/             # Business logic layer
│   │   ├── groq_service.py   # Groq API client + fallback heuristic
│   │   ├── security_service.py # AI security analysis
│   │   └── telegram_service.py # Telegram Bot API client
│   ├── schemas/              # Pydantic data models
│   │   ├── moderation.py     # Moderation request/response
│   │   ├── security.py       # Security request/response
│   │   └── telegram.py       # Telegram notification payloads
│   ├── prompts/              # AI system prompts
│   │   ├── moderation_prompt.py  # Forge Protocol (11 rules)
│   │   └── security_prompt.py    # Join & event analysis prompts
│   └── utils/                # Utilities
│       ├── config.py         # Settings from environment
│       └── logger.py         # Structured logging
├── requirements.txt          # Python dependencies
├── vercel.json               # Vercel configuration
└── README.md                 # This file
```

## Policy Notes

### Zero False Positive Policy
- Warnings require ≥95% confidence
- Below 95% → NO VIOLATION (safe default)
- Never warn an innocent member

### AI Security
- AI can NEVER execute bans automatically
- Strongest action: `ban_recommendation` (human review)
- All decisions degrade gracefully when Groq is unavailable

### Graceful Degradation
- Groq unavailable → keyword-based heuristic fallback
- Telegram unavailable → logged, never blocks Discord flow
- All endpoints always return valid JSON

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|----------|
| `GROQ_API_KEY` | ✅ | Groq API key for AI moderation |
| `GROQ_MODEL` | ❌ | Groq model (default: `llama-3.3-70b-versatile`) |
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | Telegram chat/channel ID for notifications |
| `HOST` | ❌ | Server host (default: `0.0.0.0`) |
| `PORT` | ❌ | Server port (default: `8000`) |
| `MIN_CONFIDENCE` | ❌ | Min confidence floor (default: `0.5`) |
| `MIN_WARN_CONFIDENCE` | ❌ | Min confidence for warnings (default: `0.95`) |
| `ALLOWED_ORIGINS` | ❌ | CORS origins (default: `*`) |
| `LOG_LEVEL` | ❌ | Logging level (default: `INFO`) |

## Troubleshooting

### "Groq not configured; using heuristic fallback"
- Check `GROQ_API_KEY` is set and doesn't start with `your-`
- Verify key is valid at https://console.groq.com/keys

### "Telegram not configured; skipping notification"
- Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are both set
- Neither should start with `your-`
- Verify token works: `https://api.telegram.org/bot<TOKEN>/getMe`

### Import errors
- Ensure backend root is in Python path (see `api/index.py`)
- Run from backend directory: `cd backend && python main.py`

## Development

Add new endpoints by creating route modules in `app/routes/` and including them in `app/main.py`:

```python
from app.routes.my_route import router as my_router
app.include_router(my_router)
```

All services use the singleton pattern (see `groq_service`, `security_service`, `telegram_service`).
