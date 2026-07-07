"""
Security cog — the real-time protection pipeline.

on_member_join  → risk analysis → raid detection → Telegram alerts
on_message      → scam → invites → mentions → bad words → spam/duplicates
                  → AI moderation (cheapest checks first, stop at first hit)

Every incident is stored in security_events and privately reported to the
owner via Telegram. Nothing sensitive is ever posted in Discord channels.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import discord
from discord.ext import commands, tasks

from bot.core.logging import get_logger
from bot.services.security import alerts
from bot.services.security.risk import username_suspicion

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("cogs.security")


def _fmt_age(days: float) -> str:
    if days < 1:
        return f"{days * 24:.1f} hours"
    if days < 30:
        return f"{days:.1f} days"
    if days < 365:
        return f"{days / 30.44:.1f} months"
    return f"{days / 365.25:.1f} years"


class Security(commands.Cog):
    """Automatic raid / spam / scam / abuse protection."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot
        self._own_invite_codes: dict[int, set[str]] = {}   # guild → invite codes
        self._maintenance.start()

    async def cog_unload(self) -> None:
        self._maintenance.cancel()

    # ═════════════════════════════════════════════════════════
    # helpers
    # ═════════════════════════════════════════════════════════

    async def _settings(self, guild_id: int) -> dict[str, Any]:
        return await self.bot.security_store.get_settings(guild_id)

    @staticmethod
    def _is_exempt(member: discord.Member, s: dict[str, Any]) -> bool:
        """Admins, allowed roles, ignored roles/users bypass all checks."""
        if member.bot and member.id != member.guild.me.id:
            return False  # other bots still checked for spam floods
        if member.guild_permissions.administrator:
            return True
        if member.id in set(s.get("ignored_users") or []):
            return True
        member_role_ids = {r.id for r in member.roles}
        if member_role_ids & set(s.get("allowed_roles") or []):
            return True
        if member_role_ids & set(s.get("ignored_roles") or []):
            return True
        return False

    async def _telegram(self, guild_id: int, user_id: int | None,
                        event_type: str, text: str, event_id: int,
                        s: dict[str, Any]) -> None:
        """Send a private alert and record delivery status on the event row."""
        if not s.get("enable_telegram_alerts", 1):
            await self.bot.security_store.set_event_telegram_status(event_id, "skipped")
            return
        ok = await self.bot.telegram.send(
            text, event_type=event_type, guild_id=guild_id, user_id=user_id)
        await self.bot.security_store.set_event_telegram_status(
            event_id, "sent" if ok else "failed")

    async def _refresh_own_invites(self, guild: discord.Guild) -> set[str]:
        """Cache this guild's own invite codes (for invite whitelisting)."""
        try:
            invites = await guild.invites()
            codes = {i.code for i in invites}
            if guild.vanity_url_code:
                codes.add(guild.vanity_url_code)
            self._own_invite_codes[guild.id] = codes
        except (discord.Forbidden, discord.HTTPException):
            self._own_invite_codes.setdefault(guild.id, set())
        return self._own_invite_codes[guild.id]

    # ═════════════════════════════════════════════════════════
    # member join → risk analysis + raid detection
    # ═════════════════════════════════════════════════════════

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        try:
            await self._handle_join(member)
        except Exception:  # noqa: BLE001 — never break other join listeners
            log.exception("Security join handler failed for %s", member)

    async def _handle_join(self, member: discord.Member) -> None:
        guild = member.guild
        s = await self._settings(guild.id)
        if not s.get("enable_security", 1):
            return
        store = self.bot.security_store

        # ── 1. risk analysis ─────────────────────────────────
        prev_joins = await store.previous_join_count(guild.id, member.id)
        during_raid = self.bot.raid_detector.is_active(guild.id)
        risk = self.bot.risk_analyzer.analyze(
            member,
            previous_joins=prev_joins,
            during_raid=during_raid,
            high_threshold=int(s["high_risk_score"]),
            medium_threshold=int(s["medium_risk_score"]),
        )
        await store.add_risk_score(
            guild_id=guild.id, user_id=member.id, username=str(member),
            risk_score=risk.score, risk_level=risk.level, factors=risk.factors,
            account_age_days=risk.account_age_days, during_raid=during_raid,
        )

        # invite attribution from Part 1's member record (already written by
        # the welcome cog which runs on the same event)
        await asyncio.sleep(2)  # let the welcome cog persist invite data first
        member_row = await self.bot.db.get_member(guild.id, member.id) or {}

        # medium/high risk joins → private Telegram alert
        if risk.level in ("medium", "high"):
            event_id = await store.log_event(
                guild_id=guild.id, user_id=member.id, username=str(member),
                event_type="join_risk", risk_score=risk.score,
                evidence=f"factors={risk.factors}",
                action_taken="flag",
            )
            await self._telegram(
                guild.id, member.id, "security_join_risk",
                alerts.suspicious_join({
                    "risk_emoji": risk.emoji,
                    "username": str(member),
                    "user_id": member.id,
                    "risk_score": risk.score,
                    "risk_level": risk.level.upper(),
                    "account_age": _fmt_age(risk.account_age_days),
                    "invite_code": member_row.get("invite_code") or "unknown",
                    "member_number": member_row.get("member_number") or guild.member_count,
                    "factors": ", ".join(
                        f"{k}={v}" for k, v in risk.factors.items()) or "—",
                    "recommendation": risk.recommendation,
                    "server_name": guild.name,
                }),
                event_id, s,
            )

        # ── 2. suspicious username (flag only, never auto-punish) ──
        if s.get("enable_username_check", 1) and not member.bot:
            uname_score, patterns = username_suspicion(member.name)
            if uname_score >= 15:
                event_id = await store.log_event(
                    guild_id=guild.id, user_id=member.id, username=str(member),
                    event_type="username", evidence=", ".join(patterns),
                    action_taken="flag",
                )
                await self._telegram(
                    guild.id, member.id, "security_username",
                    alerts.username_flag({
                        "username": str(member), "user_id": member.id,
                        "patterns": ", ".join(patterns),
                        "server_name": guild.name,
                    }),
                    event_id, s,
                )

        # ── 3. raid detection ────────────────────────────────
        if not s.get("enable_raid_detection", 1):
            return
        triggered, st = self.bot.raid_detector.record_join(
            guild.id, member.id, risk.score,
            threshold=int(s["raid_join_threshold"]),
            window_seconds=int(s["raid_window_seconds"]),
            min_risk=int(s["raid_min_risk"]),
        )
        if triggered:
            await self._activate_raid_mode(guild, s, st)
        elif st.active and st.raid_id:
            await store.update_raid(
                st.raid_id, join_count=len(st.joins),
                avg_risk=st.avg_risk(), user_ids=st.involved_ids(),
            )

    async def _activate_raid_mode(self, guild: discord.Guild,
                                  s: dict[str, Any], st) -> None:
        store = self.bot.security_store
        actions: list[str] = ["raid mode enabled"]

        # optional automatic channel lockdown
        if s.get("raid_auto_lockdown", 0):
            locked = await self.bot.action_executor.lockdown_guild(guild, lock=True)
            if locked:
                actions.append(f"locked {len(locked)} channels")

        st.raid_id = await store.open_raid(
            guild_id=guild.id, join_count=len(st.joins), avg_risk=st.avg_risk(),
            user_ids=st.involved_ids(), actions=actions,
        )
        await store.update_setting(guild.id, "raid_mode_active", 1)
        await store.update_setting(
            guild.id, "raid_mode_since", datetime.now(timezone.utc).isoformat())

        high_risk = sum(1 for j in st.joins if j.risk >= int(s["high_risk_score"]))
        event_id = await store.log_event(
            guild_id=guild.id, event_type="raid",
            evidence=f"{len(st.joins)} joins, avg_risk={st.avg_risk()}, "
                     f"high_risk_accounts={high_risk}",
            action_taken="; ".join(actions),
        )
        await self._telegram(
            guild.id, None, "security_raid",
            alerts.raid_alert({
                "server_name": guild.name,
                "join_count": len(st.joins),
                "window": s["raid_window_seconds"],
                "avg_risk": st.avg_risk(),
                "summary": f"{high_risk} high-risk account(s) among "
                           f"{len(st.joins)} rapid joins",
                "actions": ", ".join(actions),
            }),
            event_id, s,
        )
        log.warning("RAID MODE ACTIVE in %s — %d joins", guild.name, len(st.joins))

    # ═════════════════════════════════════════════════════════
    # message pipeline
    # ═════════════════════════════════════════════════════════

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.guild is None or message.author.id == (
                self.bot.user.id if self.bot.user else 0):
            return
        if not isinstance(message.author, discord.Member):
            return
        try:
            await self._scan_message(message)
        except Exception:  # noqa: BLE001 — pipeline must never crash the bot
            log.exception("Security message pipeline failed (msg %s)", message.id)

    async def _scan_message(self, message: discord.Message) -> None:
        assert message.guild is not None
        guild, member = message.guild, message.author
        s = await self._settings(guild.id)

        if not s.get("enable_security", 1):
            return
        if message.channel.id in set(s.get("ignored_channels") or []):
            return
        if self._is_exempt(member, s):  # type: ignore[arg-type]
            return

        content = message.content or ""
        timeout_min = int(s["timeout_minutes"])

        # ── 1. scam & phishing (highest severity first) ──────
        if s.get("enable_scam_detection", 1) and content:
            verdict = self.bot.scam_scanner.scan(
                content, whitelist_domains=s.get("whitelist_domains") or [])
            if verdict.is_scam:
                action = await self.bot.action_executor.apply(
                    member, s["punish_scam"], message=message,  # type: ignore[arg-type]
                    reason=f"Scam/phishing: {'; '.join(verdict.reasons[:3])}",
                    event_type="scam", timeout_minutes=timeout_min,
                )
                event_id = await self.bot.security_store.log_event(
                    guild_id=guild.id, user_id=member.id, username=str(member),
                    event_type="scam", channel_id=message.channel.id,
                    message_id=message.id, risk_score=verdict.score,
                    evidence=f"{content[:800]} | urls={verdict.urls} "
                             f"| reasons={verdict.reasons}",
                    action_taken=action,
                )
                await self._telegram(
                    guild.id, member.id, "security_scam",
                    alerts.scam_detected({
                        "username": str(member), "user_id": member.id,
                        "channel": getattr(message.channel, "name", "?"),
                        "message": content[:500],
                        "urls": ", ".join(verdict.urls[:5]) or "—",
                        "reasons": ", ".join(verdict.reasons[:5]),
                        "action": action, "server_name": guild.name,
                    }),
                    event_id, s,
                )
                return

        # ── 2. invite protection ─────────────────────────────
        if s.get("enable_invite_protection", 1) and content:
            own_codes = self._own_invite_codes.get(guild.id)
            if own_codes is None:
                own_codes = await self._refresh_own_invites(guild)
            inv = self.bot.scam_scanner.scan_invites(
                content, whitelist_codes=s.get("whitelist_invites") or [],
                own_guild_codes=own_codes,
            )
            if inv.blocked_codes:
                action = await self.bot.action_executor.apply(
                    member, s["punish_invite"], message=message,  # type: ignore[arg-type]
                    reason="External Discord invite links are not allowed",
                    event_type="invite", timeout_minutes=timeout_min,
                )
                # invite punishments below 'delete' still delete the ad
                if s["punish_invite"] in ("none", "warn"):
                    await self.bot.action_executor.delete_message(message)
                    action = f"deleted message, {action}"
                event_id = await self.bot.security_store.log_event(
                    guild_id=guild.id, user_id=member.id, username=str(member),
                    event_type="invite", channel_id=message.channel.id,
                    message_id=message.id,
                    evidence=f"{content[:500]} | codes={inv.blocked_codes}",
                    action_taken=action,
                )
                await self._telegram(
                    guild.id, member.id, "security_invite",
                    alerts.invite_blocked({
                        "username": str(member), "user_id": member.id,
                        "channel": getattr(message.channel, "name", "?"),
                        "codes": ", ".join(inv.blocked_codes),
                        "action": action,
                    }),
                    event_id, s,
                )
                return

        # ── 3. mention spam ──────────────────────────────────
        if s.get("enable_mention_filter", 1):
            mv = self.bot.spam_detector.check_mentions(
                message, user_limit=int(s["mention_user_limit"]),
                role_limit=int(s["mention_role_limit"]),
            )
            if mv.is_spam:
                action = await self.bot.action_executor.apply(
                    member, s["punish_mention"], message=message,  # type: ignore[arg-type]
                    reason=f"Mention spam: {mv.detail}",
                    event_type="mention_spam", timeout_minutes=timeout_min,
                )
                event_id = await self.bot.security_store.log_event(
                    guild_id=guild.id, user_id=member.id, username=str(member),
                    event_type="mention_spam", channel_id=message.channel.id,
                    message_id=message.id, evidence=f"{content[:500]} | {mv.detail}",
                    action_taken=action,
                )
                await self._telegram(
                    guild.id, member.id, "security_mention",
                    alerts.mention_spam({
                        "username": str(member), "user_id": member.id,
                        "channel": getattr(message.channel, "name", "?"),
                        "detail": mv.detail, "action": action,
                    }),
                    event_id, s,
                )
                return

        # ── 4. bad word filter ───────────────────────────────
        if s.get("enable_badword_filter", 1) and content:
            bw = self.bot.badword_filter.check(
                guild.id, content, s.get("bad_words") or [])
            if bw.matched:
                action = await self.bot.action_executor.apply(
                    member, s["punish_badword"], message=message,  # type: ignore[arg-type]
                    reason="Prohibited language",
                    event_type="badword", timeout_minutes=timeout_min,
                )
                if s["punish_badword"] in ("none", "warn"):
                    await self.bot.action_executor.delete_message(message)
                    action = f"deleted message, {action}"
                event_id = await self.bot.security_store.log_event(
                    guild_id=guild.id, user_id=member.id, username=str(member),
                    event_type="badword", channel_id=message.channel.id,
                    message_id=message.id,
                    evidence=f"{content[:500]} | matched={bw.word} via={bw.via}",
                    action_taken=action,
                )
                await self._telegram(
                    guild.id, member.id, "security_badword",
                    alerts.badword_detected({
                        "username": str(member), "user_id": member.id,
                        "channel": getattr(message.channel, "name", "?"),
                        "word": bw.word, "via": bw.via, "action": action,
                    }),
                    event_id, s,
                )
                return

        # ── 5. spam / duplicates / floods ────────────────────
        spam_hits = []
        if s.get("enable_spam_filter", 1):
            spam_hits += self.bot.spam_detector.record_and_check(
                message,
                rate_limit=int(s["spam_message_limit"]),
                rate_window=int(s["spam_window_seconds"]),
                duplicate_limit=int(s["duplicate_limit"]),
            )
            spam_hits += self.bot.spam_detector.check_content(
                content,
                emoji_limit=int(s["emoji_limit"]),
                caps_ratio=float(s["caps_ratio"]),
                caps_min_length=int(s["caps_min_length"]),
            )
        if not s.get("enable_duplicate_filter", 1):
            spam_hits = [v for v in spam_hits if v.spam_type != "duplicate"]

        if spam_hits:
            v = spam_hits[0]
            is_dup = v.spam_type == "duplicate"
            punish = s["punish_duplicate"] if is_dup else s["punish_spam"]
            action = await self.bot.action_executor.apply(
                member, punish, message=message,  # type: ignore[arg-type]
                reason=f"Spam ({v.spam_type}): {v.detail}",
                event_type="duplicate" if is_dup else "spam",
                timeout_minutes=timeout_min,
            )
            event_id = await self.bot.security_store.log_event(
                guild_id=guild.id, user_id=member.id, username=str(member),
                event_type="duplicate" if is_dup else "spam",
                channel_id=message.channel.id, message_id=message.id,
                evidence=f"{content[:500]} | "
                         f"{'; '.join(f'{x.spam_type}: {x.detail}' for x in spam_hits)}",
                action_taken=action,
            )
            await self._telegram(
                guild.id, member.id, "security_spam",
                alerts.spam_detected({
                    "username": str(member), "user_id": member.id,
                    "channel": getattr(message.channel, "name", "?"),
                    "spam_type": ", ".join(x.spam_type or "?" for x in spam_hits),
                    "message": content[:400] or "(media)",
                    "action": action, "server_name": guild.name,
                }),
                event_id, s,
            )
            return

        # ── 6. AI moderation (last — most expensive) ─────────
        if s.get("enable_ai_moderation", 0) and content and not member.bot:
            ai = await self.bot.ai_moderation.moderate(guild.id, member.id, content)
            if ai.checked:
                await self.bot.security_store.add_ai_result(
                    guild_id=guild.id, user_id=member.id,
                    channel_id=message.channel.id, message_id=message.id,
                    content=content, violation=ai.violation,
                    confidence=ai.confidence, category=ai.category,
                    reason=ai.reason, action=ai.action,
                )
            if ai.checked and ai.violation and \
                    ai.confidence >= float(s["ai_min_confidence"]):
                action = await self.bot.action_executor.apply(
                    member, s["punish_ai"], message=message,  # type: ignore[arg-type]
                    reason=f"AI moderation ({ai.category}): {ai.reason}",
                    event_type="ai_flag", timeout_minutes=timeout_min,
                )
                event_id = await self.bot.security_store.log_event(
                    guild_id=guild.id, user_id=member.id, username=str(member),
                    event_type="ai_flag", channel_id=message.channel.id,
                    message_id=message.id,
                    evidence=f"{content[:500]} | category={ai.category} "
                             f"confidence={ai.confidence:.2f} reason={ai.reason}",
                    action_taken=action,
                )
                await self._telegram(
                    guild.id, member.id, "security_ai",
                    alerts.ai_flag({
                        "username": str(member), "user_id": member.id,
                        "channel": getattr(message.channel, "name", "?"),
                        "category": ai.category or "—",
                        "confidence": f"{ai.confidence:.0%}",
                        "reason": ai.reason or "—",
                        "message": content[:400],
                        "action": action,
                    }),
                    event_id, s,
                )

    # ═════════════════════════════════════════════════════════
    # background maintenance — raid cooldown + memory pruning
    # ═════════════════════════════════════════════════════════

    @tasks.loop(seconds=30)
    async def _maintenance(self) -> None:
        try:
            for guild in self.bot.guilds:
                st = self.bot.raid_detector.state(guild.id)
                if not st.active:
                    continue
                raid_id, joins, avg = st.raid_id, len(st.joins), st.avg_risk()
                if self.bot.raid_detector.maybe_end(guild.id):
                    s = await self._settings(guild.id)
                    store = self.bot.security_store
                    await store.update_setting(guild.id, "raid_mode_active", 0)
                    if raid_id:
                        await store.update_raid(
                            raid_id, join_count=joins, avg_risk=avg,
                            user_ids=[])
                        await store.close_raid(raid_id)
                    if s.get("raid_auto_lockdown", 0):
                        await self.bot.action_executor.lockdown_guild(
                            guild, lock=False)
                    event_id = await store.log_event(
                        guild_id=guild.id, event_type="raid",
                        evidence=f"raid ended — {joins} total joins",
                        action_taken="raid mode disabled",
                    )
                    await self._telegram(
                        guild.id, None, "security_raid_end",
                        alerts.raid_ended({
                            "server_name": guild.name,
                            "join_count": joins, "avg_risk": avg,
                        }),
                        event_id, s,
                    )
                    log.info("Raid mode ended in %s", guild.name)
            self.bot.spam_detector.prune()
        except Exception:  # noqa: BLE001
            log.exception("Security maintenance tick failed")

    @_maintenance.before_loop
    async def _before_maintenance(self) -> None:
        await self.bot.wait_until_ready()


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(Security(bot))
