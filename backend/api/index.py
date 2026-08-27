"""
Vercel serverless entry point.

Vercel's Python runtime auto-detects the FastAPI `app` object exported here
(api/index.py is a recognized entrypoint) and serves the WHOLE app as a
single Vercel Function for ALL request paths — no rewrites needed. FastAPI's
own router then matches the original path (POST /moderate, GET /health,
GET /, ...).

NOTE: do NOT add a `rewrites` rule pointing to /api/index in vercel.json.
With Vercel's FastAPI framework detection, such a rewrite replaces the
request path the ASGI app receives with the literal destination
"/api/index", so every route 404s with {"detail":"Not Found"}.

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
