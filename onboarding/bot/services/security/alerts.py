"""
Security alert builders — private Telegram notifications for the owner.

Sensitive details (usernames, IDs, message content, URLs) are NEVER posted
in Discord channels; they go to Telegram only. Every builder returns
HTML-formatted text for TelegramNotifier.send().
"""
from __future__ import annotations

from datetime import datetime, timezone

from bot.services.telegram import esc


def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def suspicious_join(data: dict) -> str:
    return (
        f"{esc(data['risk_emoji'])} <b>Suspicious Member Joined</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"👤 <b>Username:</b> {esc(data['username'])}\n"
        f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
        f"📊 <b>Risk Score:</b> {esc(data['risk_score'])}/100 ({esc(data['risk_level'])})\n"
        f"⌛ <b>Account Age:</b> {esc(data['account_age'])}\n"
        f"🔗 <b>Invite Used:</b> <code>{esc(data['invite_code'])}</code>\n"
        f"🔢 <b>Member #:</b> {esc(data['member_number'])}\n"
        f"⚠️ <b>Risk Factors:</b> {esc(data['factors'])}\n"
        f"💡 <b>Recommended:</b> {esc(data['recommendation'])}\n"
        f"🏠 <b>Server:</b> {esc(data['server_name'])}\n"
        f"⏰ {_ts()}"
    )


def spam_detected(data: dict) -> str:
    return (
        "🚨 <b>Spam Detected</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"👤 <b>Username:</b> {esc(data['username'])}\n"
        f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
        f"📺 <b>Channel:</b> #{esc(data['channel'])}\n"
        f"🏷 <b>Spam Type:</b> {esc(data['spam_type'])}\n"
        f"💬 <b>Message:</b> <code>{esc(data['message'])}</code>\n"
        f"🔨 <b>Action Taken:</b> {esc(data['action'])}\n"
        f"🏠 <b>Server:</b> {esc(data['server_name'])}\n"
        f"⏰ {_ts()}"
    )


def scam_detected(data: dict) -> str:
    return (
        "☠️ <b>Scam Link Detected</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"👤 <b>Username:</b> {esc(data['username'])}\n"
        f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
        f"📺 <b>Channel:</b> #{esc(data['channel'])}\n"
        f"💬 <b>Full Message:</b> <code>{esc(data['message'])}</code>\n"
        f"🔗 <b>Suspicious URL(s):</b> <code>{esc(data['urls'])}</code>\n"
        f"🧾 <b>Indicators:</b> {esc(data['reasons'])}\n"
        f"🔨 <b>Action Taken:</b> {esc(data['action'])}\n"
        f"🏠 <b>Server:</b> {esc(data['server_name'])}\n"
        f"⏰ {_ts()}"
    )


def raid_alert(data: dict) -> str:
    return (
        "⚔️ <b>RAID ALERT</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"🏠 <b>Server:</b> {esc(data['server_name'])}\n"
        f"👥 <b>Join Count:</b> {esc(data['join_count'])} in {esc(data['window'])}s\n"
        f"📊 <b>Avg Risk Score:</b> {esc(data['avg_risk'])}/100\n"
        f"🧾 <b>Risk Summary:</b> {esc(data['summary'])}\n"
        f"🤖 <b>Automatic Actions:</b> {esc(data['actions'])}\n"
        f"⏰ {_ts()}"
    )


def raid_ended(data: dict) -> str:
    return (
        "🕊 <b>Raid Ended</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"🏠 <b>Server:</b> {esc(data['server_name'])}\n"
        f"👥 <b>Total Joins:</b> {esc(data['join_count'])}\n"
        f"📊 <b>Avg Risk:</b> {esc(data['avg_risk'])}/100\n"
        f"⏰ {_ts()}"
    )


def mention_spam(data: dict) -> str:
    return (
        "📣 <b>Mention Spam Detected</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"👤 <b>Username:</b> {esc(data['username'])}\n"
        f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
        f"📺 <b>Channel:</b> #{esc(data['channel'])}\n"
        f"🧾 <b>Detail:</b> {esc(data['detail'])}\n"
        f"🔨 <b>Action Taken:</b> {esc(data['action'])}\n"
        f"⏰ {_ts()}"
    )


def invite_blocked(data: dict) -> str:
    return (
        "🔗 <b>External Invite Blocked</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"👤 <b>Username:</b> {esc(data['username'])}\n"
        f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
        f"📺 <b>Channel:</b> #{esc(data['channel'])}\n"
        f"🎟 <b>Invite Code(s):</b> <code>{esc(data['codes'])}</code>\n"
        f"🔨 <b>Action Taken:</b> {esc(data['action'])}\n"
        f"⏰ {_ts()}"
    )


def ai_flag(data: dict) -> str:
    return (
        "🤖 <b>AI Moderation Flag</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"👤 <b>Username:</b> {esc(data['username'])}\n"
        f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
        f"📺 <b>Channel:</b> #{esc(data['channel'])}\n"
        f"🏷 <b>Category:</b> {esc(data['category'])}\n"
        f"📈 <b>Confidence:</b> {esc(data['confidence'])}\n"
        f"🧾 <b>Reason:</b> {esc(data['reason'])}\n"
        f"💬 <b>Message:</b> <code>{esc(data['message'])}</code>\n"
        f"🔨 <b>Action Taken:</b> {esc(data['action'])}\n"
        f"⏰ {_ts()}"
    )


def username_flag(data: dict) -> str:
    return (
        "🕵️ <b>Suspicious Username Flagged</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"👤 <b>Username:</b> {esc(data['username'])}\n"
        f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
        f"🧾 <b>Patterns:</b> {esc(data['patterns'])}\n"
        f"💡 <b>Recommended:</b> Review manually — no automatic action taken\n"
        f"🏠 <b>Server:</b> {esc(data['server_name'])}\n"
        f"⏰ {_ts()}"
    )


def badword_detected(data: dict) -> str:
    return (
        "🧼 <b>Bad Word Filter Triggered</b>\n"
        "━━━━━━━━━━━━━━━━━━\n"
        f"👤 <b>Username:</b> {esc(data['username'])}\n"
        f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
        f"📺 <b>Channel:</b> #{esc(data['channel'])}\n"
        f"🎯 <b>Matched:</b> <code>{esc(data['word'])}</code> ({esc(data['via'])})\n"
        f"🔨 <b>Action Taken:</b> {esc(data['action'])}\n"
        f"⏰ {_ts()}"
    )
