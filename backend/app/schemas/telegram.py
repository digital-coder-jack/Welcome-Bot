"""
schemas/telegram.py
---------------------------------------------------------------------------
Pydantic models defining the API contract for all Telegram notification
endpoints. The Discord bot posts these payloads; the backend validates them
and relays a formatted message to Telegram.

Endpoints covered:
  POST /telegram/member-joined
  POST /telegram/member-left
  POST /telegram/warning
  POST /telegram/kick
  POST /telegram/ban
  POST /telegram/security-alert
---------------------------------------------------------------------------
"""

from typing import Optional

from pydantic import BaseModel, Field


class MemberJoinedPayload(BaseModel):
    """Payload sent by the bot when a new member joins the server."""

    username: str = Field(..., description="Discord username (e.g. jack_dev).")
    display_name: str = Field(..., description="Server display name / global name.")
    user_id: str = Field(..., description="Discord user ID (snowflake).")
    server_name: str = Field(..., description="Name of the Discord server.")
    join_time: str = Field(..., description="ISO timestamp of the join.")
    account_created: str = Field(..., description="ISO timestamp of account creation.")
    account_age: str = Field(..., description="Human-readable account age (e.g. '2 years, 3 months').")
    member_number: int = Field(..., ge=0, description="This member's join position (guild member count).")
    invite_code: str = Field("Unknown", description="Invite code used to join, if resolvable.")
    inviter: str = Field("Unknown", description="Tag of the user whose invite was used.")
    bot_or_human: str = Field("Human", description="'Bot' or 'Human'.")
    avatar_url: str = Field("", description="URL of the member's avatar.")
    assigned_role: str = Field("None", description="Role auto-assigned on join.")
    dm_status: str = Field("Unknown", description="Whether the welcome DM was delivered.")
    server_invite_used: str = Field("Unknown", description="Full invite URL that was used.")


class MemberLeftPayload(BaseModel):
    """Payload sent by the bot when a member leaves the server."""

    username: str = Field(..., description="Discord username.")
    display_name: str = Field("", description="Server display name at time of leaving.")
    user_id: str = Field(..., description="Discord user ID.")
    server_name: str = Field(..., description="Name of the Discord server.")
    leave_time: str = Field(..., description="ISO timestamp of the departure.")
    joined_at: str = Field("Unknown", description="ISO timestamp of when they had joined.")
    time_in_server: str = Field("Unknown", description="Human-readable membership duration.")
    member_count: int = Field(0, ge=0, description="Guild member count after the departure.")
    roles: str = Field("None", description="Comma-separated roles the member had.")
    avatar_url: str = Field("", description="URL of the member's avatar.")


class WarningPayload(BaseModel):
    """Payload sent by the bot when a member receives a warning."""

    username: str = Field(..., description="Discord username of the warned member.")
    user_id: str = Field(..., description="Discord user ID of the warned member.")
    server_name: str = Field(..., description="Name of the Discord server.")
    reason: str = Field("No reason provided", description="Reason for the warning.")
    rule: Optional[str] = Field(None, description="Rule label the warning relates to.")
    moderator: str = Field("Unknown", description="Tag of the moderator (or 'AI Moderator').")
    warning_count: int = Field(..., ge=1, description="Current warning count for the member.")
    max_warnings: int = Field(..., ge=1, description="Warnings threshold before removal.")
    source: str = Field("command", description="'command' | 'auto' | 'ai'.")
    timestamp: str = Field(..., description="ISO timestamp of the warning.")


class KickPayload(BaseModel):
    """Payload sent by the bot when a member is kicked."""

    username: str = Field(..., description="Discord username of the kicked member.")
    user_id: str = Field(..., description="Discord user ID of the kicked member.")
    server_name: str = Field(..., description="Name of the Discord server.")
    reason: str = Field("No reason provided", description="Reason for the kick.")
    moderator: str = Field("Unknown", description="Tag of the moderator (or 'Auto-Mod').")
    warning_count: Optional[int] = Field(None, ge=0, description="Warnings at time of kick, if applicable.")
    timestamp: str = Field(..., description="ISO timestamp of the kick.")


class BanPayload(BaseModel):
    """Payload sent by the bot when a member is banned."""

    username: str = Field(..., description="Discord username of the banned member.")
    user_id: str = Field(..., description="Discord user ID of the banned member.")
    server_name: str = Field(..., description="Name of the Discord server.")
    reason: str = Field("No reason provided", description="Reason for the ban.")
    moderator: str = Field("Unknown", description="Tag of the moderator who banned.")
    timestamp: str = Field(..., description="ISO timestamp of the ban.")


class SecurityAlertPayload(BaseModel):
    """Payload sent by the bot for security events (raids, scams, AI flags...)."""

    alert_type: str = Field(..., description="Category, e.g. 'AI Violation', 'Raid Suspected', 'Scam Link'.")
    severity: str = Field("medium", description="'low' | 'medium' | 'high' | 'critical'.")
    server_name: str = Field(..., description="Name of the Discord server.")
    username: str = Field("Unknown", description="Username involved, if any.")
    user_id: str = Field("", description="User ID involved, if any.")
    channel: str = Field("", description="Channel name where the event occurred.")
    details: str = Field(..., description="Human-readable description of the event.")
    timestamp: str = Field(..., description="ISO timestamp of the alert.")


class TelegramResponse(BaseModel):
    """Standard response for every /telegram/* endpoint."""

    success: bool = Field(..., description="Whether the Telegram message was delivered.")
    message: str = Field(..., description="Human-readable status message.")
