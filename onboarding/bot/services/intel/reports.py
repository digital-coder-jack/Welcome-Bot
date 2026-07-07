"""
Telegram report builders for the v2.0 Member Intelligence module.

Formatted security reports matching the requested layout:

━━━━━━━━━━━━━━
👤 New User Detected
Username: ...
━━━━━━━━━━━━━━

All builders return HTML-formatted text for TelegramNotifier.send().
"""
from __future__ import annotations

from datetime import datetime, timezone

from bot.services.telegram import esc

_BAR = "━━━━━━━━━━━━━━"


def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def user_detected(d: dict) -> str:
    """New user / import / rejoin detection record."""
    title = d.get("title", "👤 New User Detected")
    return (
        f"{_BAR}\n"
        f"<b>{esc(title)}</b>\n\n"
        f"<b>Username:</b> {esc(d.get('username'))}\n"
        f"<b>Display Name:</b> {esc(d.get('display_name'))}\n"
        f"<b>User ID:</b> <code>{esc(d.get('user_id'))}</code>\n"
        f"<b>Created:</b> {esc(d.get('created'))}\n"
        f"<b>Joined:</b> {esc(d.get('joined'))}\n"
        f"<b>Avatar:</b> {esc(d.get('avatar'))}\n"
        f"<b>Roles:</b> {esc(d.get('roles'))}\n"
        f"<b>Flags:</b> {esc(d.get('flags'))}\n"
        f"<b>Bot:</b> {esc(d.get('bot'))}\n"
        f"<b>Booster:</b> {esc(d.get('booster'))}\n"
        f"<b>Status:</b> {esc(d.get('status'))}\n"
        f"<b>Imported:</b> {esc(d.get('imported'))}\n"
        f"<b>Rejoined:</b> {esc(d.get('rejoined'))}\n"
        f"<b>Joins/Leaves:</b> {esc(d.get('join_count'))} / {esc(d.get('leave_count'))}\n"
        f"<b>Server:</b> {esc(d.get('server_name'))}\n"
        f"⏰ {_ts()}\n"
        f"{_BAR}"
    )


def member_left(d: dict) -> str:
    return (
        f"{_BAR}\n"
        f"<b>🔴 Member Left</b>\n\n"
        f"<b>Username:</b> {esc(d.get('username'))}\n"
        f"<b>User ID:</b> <code>{esc(d.get('user_id'))}</code>\n"
        f"<b>Joined:</b> {esc(d.get('joined'))}\n"
        f"<b>Time in server:</b> {esc(d.get('duration'))}\n"
        f"<b>Roles at exit:</b> {esc(d.get('roles'))}\n"
        f"<b>Total joins:</b> {esc(d.get('join_count'))}\n"
        f"<b>Total leaves:</b> {esc(d.get('leave_count'))}\n"
        f"<b>Server:</b> {esc(d.get('server_name'))}\n"
        f"⏰ {_ts()}\n"
        f"{_BAR}"
    )


def profile_changed(d: dict) -> str:
    lines = "\n".join(
        f"• <b>{esc(c['field'])}:</b> <code>{esc(c['old'])}</code> → "
        f"<code>{esc(c['new'])}</code>"
        for c in d.get("changes", [])
    )
    return (
        f"{_BAR}\n"
        f"<b>✏️ Profile Update Detected</b>\n\n"
        f"<b>Username:</b> {esc(d.get('username'))}\n"
        f"<b>User ID:</b> <code>{esc(d.get('user_id'))}</code>\n"
        f"<b>Changes:</b>\n{lines or '—'}\n"
        f"<b>Server:</b> {esc(d.get('server_name'))}\n"
        f"⏰ {_ts()}\n"
        f"{_BAR}"
    )


def warning_issued(d: dict) -> str:
    return (
        f"{_BAR}\n"
        f"<b>{esc(d.get('level_emoji', '⚠️'))} Warning Issued — Level "
        f"{esc(d.get('level'))}</b>\n\n"
        f"<b>User:</b> {esc(d.get('username'))}\n"
        f"<b>User ID:</b> <code>{esc(d.get('user_id'))}</code>\n"
        f"<b>Moderator:</b> {esc(d.get('moderator'))}\n"
        f"<b>Reason:</b> {esc(d.get('reason'))}\n"
        f"<b>Warning count:</b> {esc(d.get('count'))}\n"
        f"<b>DM delivered:</b> {esc(d.get('dm'))}\n"
        f"<b>Action taken:</b> {esc(d.get('action'))}\n"
        f"<b>Server:</b> {esc(d.get('server_name'))}\n"
        f"⏰ {_ts()}\n"
        f"{_BAR}"
    )


def final_action(d: dict) -> str:
    return (
        f"{_BAR}\n"
        f"<b>🔨 Level 3 — Final Action: {esc(d.get('action', '?').upper())}</b>\n\n"
        f"<b>User:</b> {esc(d.get('username'))}\n"
        f"<b>User ID:</b> <code>{esc(d.get('user_id'))}</code>\n"
        f"<b>Moderator:</b> {esc(d.get('moderator'))}\n"
        f"<b>Final reason:</b> {esc(d.get('reason'))}\n"
        f"<b>DM delivered:</b> {esc(d.get('dm'))}\n"
        f"<b>Action success:</b> {esc(d.get('success'))}\n"
        f"<b>Warning history:</b>\n{esc(d.get('history'))}\n"
        f"<b>Server:</b> {esc(d.get('server_name'))}\n"
        f"⏰ {_ts()}\n"
        f"{_BAR}"
    )


def scan_report(d: dict) -> str:
    return (
        f"{_BAR}\n"
        f"<b>🗂 Initial Member Scan Complete</b>\n\n"
        f"<b>Server:</b> {esc(d.get('server_name'))}\n"
        f"<b>Members imported:</b> {esc(d.get('imported'))}\n"
        f"<b>Bots:</b> {esc(d.get('bots'))}\n"
        f"<b>Humans:</b> {esc(d.get('humans'))}\n"
        f"<b>Duration:</b> {esc(d.get('duration'))}\n"
        f"<b>Note:</b> No welcome messages were sent (imported records only).\n"
        f"⏰ {_ts()}\n"
        f"{_BAR}"
    )
