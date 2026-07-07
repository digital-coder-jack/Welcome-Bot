"""
Vercel serverless entry point.

Vercel's Python runtime auto-detects the ASGI `app` object exported here
and serves it as a serverless function. All routes are rewritten to this
file via backend/vercel.json, so the full FastAPI app (POST /moderate,
GET /health, GET /) works unchanged.

Local dev is unaffected — keep using:  uvicorn app.main:app --reload
"""

import os
import sys

# Ensure the backend root (parent of api/) is importable so `app.*` resolves
# regardless of how Vercel bundles the function.
_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)

from app.main import app  # noqa: E402  (ASGI app exported for Vercel)
