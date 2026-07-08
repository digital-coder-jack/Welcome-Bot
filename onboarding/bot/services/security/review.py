"""
Moderation Review Manager — the moderator-approval workflow (Forge Guardian).

THE core guarantee of this module:

    The bot NEVER kicks or bans anyone by itself. Every kick/ban proposal
    becomes a pending review posted to the configured #security-alerts
    channel; the punishment only happens after an authorized moderator
    (Administrator or the configured Security Team role) presses a button.

Reliability properties:
  • No duplicate alerts    — UNIQUE partial index on pending reviews.
  • No double punishments  — atomic claim() UPDATE; only one moderator wins.
  • Buttons disable        — the alert message is edited immediately after
                             one action completes.
  • Restart-safe           — a persistent dynamic View (custom_id carries the
                             review id) is re-registered in setup_hook.
  • Failure-safe           — if the action fails (permissions / member left)
                             the review is released back to pending.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

import discord

from bot.core.logging import get_logger
from bot.utils.formatting import utcnow

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("security.review")

CONFIDENCE_EMOJI = {"low": "🟢", "medium": "🟡", "high": "🔴"}
ACTION_EMOJI = {"warn": "⚠️", "timeout": "⏳", "kick": "👢", "ban": "🔨",
                "manual_review": "🔍", "dismiss": "❌"}
TIMEOUT_MINUTES_DEFAULT = 60

_CID = re.compile(r"^fg_review:(\d+):(warn|timeout|kick|ban|dismiss|evidence)$")


# ═════════════════════════════════════════════════════════════
# persistent buttons
# ═════════════════════════════════════════════════════════════

class ReviewView(discord.ui.View):
    """Security-alert action row. custom_ids embed the review id so the
    view survives bot restarts (registered as a persistent view)."""

    def __init__(self, bot: "ForgeBot", review_id: int, lang: str = "en",
                 *, disabled: bool = False) -> None:
        super().__init__(timeout=None)
        t = bot.i18n.t
        buttons = (
            ("warn", t(lang, "btn.final_warning"), discord.ButtonStyle.primary),
            ("timeout", t(lang, "btn.timeout"), discord.ButtonStyle.secondary),
            ("kick", t(lang, "btn.kick"), discord.ButtonStyle.danger),
            ("ban", t(lang, "btn.ban"), discord.ButtonStyle.danger),
            ("dismiss", t(lang, "btn.dismiss"), discord.ButtonStyle.secondary),
            ("evidence", t(lang, "btn.evidence"), discord.ButtonStyle.secondary),
        )
        for action, label, style in buttons:
            self.add_item(discord.ui.Button(
                label=label, style=style, disabled=disabled,
                custom_id=f"fg_review:{review_id}:{action}",
            ))


class PersistentReviewListener(discord.ui.View):
    """Registered once at startup so buttons keep working after restarts.
    Actual dispatch happens in ReviewManager.handle_interaction via the
    on_interaction listener — this empty persistent view just makes Discord
    deliver component interactions for our custom_id namespace."""

    def __init__(self) -> None:
        super().__init__(timeout=None)


# ═════════════════════════════════════════════════════════════
# manager
# ═════════════════════════════════════════════════════════════

class ReviewManager:
    """Creates review alerts and executes button-approved actions."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot

    # ── helpers ──────────────────────────────────────────────

    async def _lang(self, guild_id: int) -> str:
        return await self.bot.guardian_store.language(guild_id)

    @staticmethod
    def _is_authorized(member: discord.Member, security_role_id: int | None) -> bool:
        if member.guild_permissions.administrator:
            return True
        if member.id == member.guild.owner_id:
            return True
        if security_role_id and any(r.id == security_role_id for r in member.roles):
            return True
        return False

    async def _alerts_channel(self, guild: discord.Guild) -> discord.TextChannel | None:
        gs = await self.bot.guardian_store.get_settings(guild.id)
        cid = gs.get("security_alerts_channel_id")
        channel = guild.get_channel(int(cid)) if cid else None
        if channel is None:
            # fallback: a channel literally named security-alerts
            channel = discord.utils.get(guild.text_channels, name="security-alerts")
        if channel is None:
            return None
        me = guild.me
        if me and not channel.permissions_for(me).send_messages:
            return None
        return channel  # type: ignore[return-value]

    @staticmethod
    def _history_text(history: list[dict], limit: int = 8) -> str:
        if not history:
            return "—"
        lines = []
        for i, w in enumerate(history[:limit], 1):
            ts = (w.get("created_at") or "")[:16].replace("T", " ")
            lines.append(f"`{i}.` {w.get('reason', '—')} · {ts}")
        if len(history) > limit:
            lines.append(f"… and {len(history) - limit} more")
        return "\n".join(lines)[:1024]

    # ── embed builder ────────────────────────────────────────

    async def build_alert_embed(self, guild: discord.Guild,
                                review: dict) -> discord.Embed:
        lang = await self._lang(guild.id)
        t = self.bot.i18n.t
        conf = (review.get("confidence") or "medium").lower()
        rec = (review.get("recommended_action") or "kick").lower()

        member_mention = f"<@{review['user_id']}>"
        embed = discord.Embed(
            title=t(lang, "review.title"),
            description=t(lang, "review.desc", member=member_mention),
            color=discord.Color.red() if conf == "high"
            else discord.Color.orange() if conf == "medium"
            else discord.Color.gold(),
            timestamp=utcnow(),
        )
        embed.add_field(name=t(lang, "review.member"),
                        value=f"{member_mention}\n`{review.get('username') or '?'}`",
                        inline=True)
        embed.add_field(name=t(lang, "review.user_id"),
                        value=f"`{review['user_id']}`", inline=True)
        embed.add_field(name=t(lang, "review.warnings"),
                        value=f"`{review.get('warning_count', 0)}`", inline=True)
        if review.get("account_created_at"):
            embed.add_field(name=t(lang, "review.account_created"),
                            value=str(review["account_created_at"])[:16].replace("T", " "),
                            inline=True)
        if review.get("joined_at"):
            embed.add_field(name=t(lang, "review.joined"),
                            value=str(review["joined_at"])[:16].replace("T", " "),
                            inline=True)
        if review.get("risk_score") is not None:
            embed.add_field(name=t(lang, "review.risk"),
                            value=f"`{review['risk_score']}/100`", inline=True)
        embed.add_field(name=t(lang, "review.roles"),
                        value=(review.get("roles_text") or "—")[:1024], inline=False)
        embed.add_field(name=t(lang, "review.violation"),
                        value=(review.get("violation") or "—")[:1024], inline=False)

        evidence = review.get("evidence") or []
        if evidence:
            embed.add_field(
                name=t(lang, "review.evidence"),
                value="\n".join(f"• {e}" for e in evidence[:8])[:1024],
                inline=False)
        history = review.get("history") or []
        if history:
            embed.add_field(name=t(lang, "review.history"),
                            value=self._history_text(history), inline=False)
        timeline = review.get("timeline") or []
        if timeline:
            lines = []
            for ev in timeline[:6]:
                ts = (ev.get("at") or "")[:16].replace("T", " ")
                lines.append(f"`{ts}` — {ev.get('what', '—')}")
            embed.add_field(name=t(lang, "review.timeline"),
                            value="\n".join(lines)[:1024], inline=False)

        embed.add_field(
            name=t(lang, "review.confidence"),
            value=f"{CONFIDENCE_EMOJI.get(conf, '🟡')} **{conf.upper()}**",
            inline=True)
        embed.add_field(
            name=t(lang, "review.recommended"),
            value=f"{ACTION_EMOJI.get(rec, '🔍')} **{rec.replace('_', ' ').title()}**",
            inline=True)
        embed.set_footer(text=t(lang, "review.footer", id=review["id"]))
        return embed

    # ── public API: open a review ────────────────────────────

    async def open_review(
        self, member: discord.Member, *, source: str, violation: str,
        recommended_action: str, confidence: str,
        evidence: list[str], history: list[dict],
        timeline: list[dict] | None = None,
        risk_score: int | None = None,
    ) -> int | None:
        """
        Create a pending moderation review and post the security alert.
        Returns the review id, or None when a review is already pending
        (duplicate suppression) or the alert channel is unavailable.
        Accuracy over speed: when confidence is low, the recommendation is
        downgraded to manual review instead of escalating.
        """
        guild = member.guild
        if (confidence or "medium").lower() == "low" and \
                recommended_action in ("kick", "ban"):
            recommended_action = "manual_review"

        roles_text = ", ".join(
            r.mention for r in member.roles[1:][:15]) or "—"
        review_id = await self.bot.guardian_store.create_review(
            guild_id=guild.id, user_id=member.id, username=str(member),
            source=source, violation=violation,
            recommended_action=recommended_action, confidence=confidence,
            risk_score=risk_score, evidence=evidence, history=history,
            timeline=timeline,
            account_created_at=member.created_at.isoformat(),
            joined_at=member.joined_at.isoformat() if member.joined_at else None,
            roles_text=roles_text,
            warning_count=len(history),
        )
        if review_id is None:
            return None  # duplicate — alert already pending for this member

        review = await self.bot.guardian_store.get_review(review_id)
        lang = await self._lang(guild.id)
        embed = await self.build_alert_embed(guild, review or {})
        view = ReviewView(self.bot, review_id, lang)

        channel = await self._alerts_channel(guild)
        posted = False
        if channel is not None:
            try:
                msg = await channel.send(embed=embed, view=view)
                await self.bot.guardian_store.set_alert_message(
                    review_id, channel.id, msg.id)
                posted = True
            except discord.HTTPException:
                log.exception("Failed to post security alert (guild %s)", guild.id)

        # also DM the owner / configured admins so nothing is missed
        gs = await self.bot.guardian_store.get_settings(guild.id)
        if gs.get("notify_owner", 1) and guild.owner:
            try:
                await guild.owner.send(embed=embed, view=ReviewView(
                    self.bot, review_id, lang))
            except (discord.Forbidden, discord.HTTPException):
                pass

        await self.bot.guardian_store.add_modlog(
            guild_id=guild.id, action="review_opened", user_id=member.id,
            username=str(member), reason=violation,
            evidence="; ".join(evidence[:5]))
        if not posted:
            log.warning("No #security-alerts channel in guild %s — review #%s "
                        "created but only owner-DM was possible",
                        guild.id, review_id)
        return review_id

    # ── interaction dispatch (called from on_interaction) ────

    async def handle_interaction(self, interaction: discord.Interaction) -> bool:
        """Route fg_review:* button presses. Returns True when handled."""
        data = interaction.data or {}
        cid = data.get("custom_id") or ""
        m = _CID.match(cid)
        if not m:
            return False
        review_id, action = int(m.group(1)), m.group(2)
        try:
            await self._process(interaction, review_id, action)
        except Exception:  # noqa: BLE001
            log.exception("Review interaction failed (#%s %s)", review_id, action)
            if not interaction.response.is_done():
                await interaction.response.send_message(
                    "⚠️ Something went wrong processing this action.",
                    ephemeral=True)
        return True

    async def _process(self, interaction: discord.Interaction,
                       review_id: int, action: str) -> None:
        store = self.bot.guardian_store
        review = await store.get_review(review_id)
        guild = interaction.guild or (
            self.bot.get_guild(review["guild_id"]) if review else None)
        if review is None or guild is None:
            await interaction.response.send_message(
                "ℹ️ This review no longer exists.", ephemeral=True)
            return

        lang = await self._lang(guild.id)
        t = self.bot.i18n.t
        gs = await store.get_settings(guild.id)

        # ── permission gate ──────────────────────────────────
        actor = guild.get_member(interaction.user.id)
        if actor is None or not self._is_authorized(
                actor, gs.get("security_team_role_id")):
            await interaction.response.send_message(
                t(lang, "review.no_permission"), ephemeral=True)
            return

        # ── evidence view: read-only, never claims the review ─
        if action == "evidence":
            await self._send_evidence(interaction, review, lang)
            return

        # ── already resolved? ────────────────────────────────
        if review["status"] not in ("pending", "processing"):
            await interaction.response.send_message(
                t(lang, "review.already_handled"), ephemeral=True)
            return

        # ── atomic claim: only ONE moderator can act ─────────
        if not await store.claim(review_id, actor.id):
            await interaction.response.send_message(
                t(lang, "review.claimed"), ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)

        member = guild.get_member(review["user_id"])
        ok, note = await self._execute(guild, member, review, action, actor, lang)

        if not ok and action != "dismiss":
            await store.release(review_id)
            await interaction.followup.send(
                t(lang, "review.action_failed"), ephemeral=True)
            return

        # resolve + disable the buttons on the alert message
        await store.resolve(review_id, moderator_id=actor.id, action=action)
        await self._disable_alert(guild, review, action, actor, lang)

        key = f"review.resolved.{action}"
        await interaction.followup.send(
            t(lang, key, moderator=actor.mention) + (f"\n{note}" if note else ""),
            ephemeral=True)

    # ── execution ────────────────────────────────────────────

    async def _execute(
        self, guild: discord.Guild, member: discord.Member | None,
        review: dict, action: str, actor: discord.Member, lang: str,
    ) -> tuple[bool, str]:
        """Perform the approved action. Returns (success, extra note)."""
        t = self.bot.i18n.t
        store = self.bot.guardian_store
        reason = review.get("violation") or "Rule violation"
        history_text = self._history_text(review.get("history") or [])
        user_id, username = review["user_id"], review.get("username")
        note = ""

        if action == "dismiss":
            await store.add_modlog(
                guild_id=guild.id, action="review_dismissed",
                user_id=user_id, username=username,
                moderator_id=actor.id, reason=reason)
            await self._modlog_embed(guild, "log.security", user=username,
                                     user_id=user_id, moderator=actor,
                                     reason=f"Review #{review['id']} dismissed",
                                     lang=lang)
            return True, ""

        if member is None:
            if action == "ban":
                # ban works even if the member already left
                try:
                    await guild.ban(discord.Object(id=user_id),
                                    reason=f"[Forge Guardian] {reason}"[:512])
                except (discord.Forbidden, discord.HTTPException) as exc:
                    return False, str(exc)
                await store.add_modlog(
                    guild_id=guild.id, action="ban", user_id=user_id,
                    username=username, moderator_id=actor.id, reason=reason)
                await self._modlog_embed(guild, "log.ban", user=username,
                                         user_id=user_id, moderator=actor,
                                         reason=reason, lang=lang)
                return True, "ℹ️ Member had already left — ban applied by ID."
            return False, "Member is no longer in the server."

        # notify the member FIRST (can't DM after kick/ban)
        dm_ok = False
        if action in ("kick", "ban"):
            text = t(lang, f"notice.{action}", server=guild.name,
                     reason=reason, history=history_text)
            dm_ok = await self._dm(member, text)
        elif action == "warn":
            dm_ok = await self._dm(member, t(
                lang, "notice.warn.final", server=guild.name, reason=reason))
        elif action == "timeout":
            dm_ok = await self._dm(member, t(
                lang, "notice.timeout", server=guild.name, reason=reason,
                duration=TIMEOUT_MINUTES_DEFAULT))

        full_reason = f"Review #{review['id']} approved by {actor}: {reason}"
        ok = True
        if action == "warn":
            await self.bot.security_store.add_warning(
                guild_id=guild.id, user_id=member.id, username=str(member),
                reason=f"FINAL WARNING (review #{review['id']}): {reason}",
                event_type="review_final_warn", moderator_id=actor.id)
            log_key = "log.warning"
        elif action == "timeout":
            ok = await self.bot.action_executor.timeout(
                member, minutes=TIMEOUT_MINUTES_DEFAULT, reason=full_reason,
                event_type="review_timeout", moderator_id=actor.id)
            log_key = "log.timeout"
        elif action == "kick":
            ok = await self.bot.action_executor.kick(
                member, reason=full_reason, event_type="review_kick",
                moderator_id=actor.id)
            log_key = "log.kick"
        else:  # ban
            ok = await self.bot.action_executor.ban(
                member, reason=full_reason, event_type="review_ban",
                moderator_id=actor.id)
            log_key = "log.ban"

        if ok:
            await store.add_modlog(
                guild_id=guild.id, action=action, user_id=member.id,
                username=str(member), moderator_id=actor.id, reason=reason,
                evidence="; ".join((review.get("evidence") or [])[:5]))
            await self._modlog_embed(
                guild, log_key, user=str(member), user_id=member.id,
                moderator=actor, reason=reason, lang=lang,
                evidence="\n".join(
                    f"• {e}" for e in (review.get("evidence") or [])[:5]))
            note = "" if dm_ok else "ℹ️ Member could not be DM'd (DMs closed)."
        return ok, note

    async def _dm(self, member: discord.Member, text: str) -> bool:
        try:
            await member.send(text)
            return True
        except (discord.Forbidden, discord.HTTPException):
            return False

    # ── alert message maintenance ────────────────────────────

    async def _disable_alert(self, guild: discord.Guild, review: dict,
                             action: str, actor: discord.Member,
                             lang: str) -> None:
        """Edit the alert: disabled buttons + resolution banner. Guarantees
        nobody can press the buttons again after one action completed."""
        cid, mid = review.get("alert_channel_id"), review.get("alert_message_id")
        if not (cid and mid):
            return
        channel = guild.get_channel(int(cid))
        if channel is None:
            return
        try:
            msg = await channel.fetch_message(int(mid))
            embed = msg.embeds[0] if msg.embeds else discord.Embed()
            t = self.bot.i18n.t
            emoji = ACTION_EMOJI.get(action, "✅")
            embed.color = discord.Color.dark_grey()
            embed.add_field(
                name="✅ Resolved",
                value=f"{emoji} **{action.upper()}** by {actor.mention} · "
                      f"<t:{int(utcnow().timestamp())}:R>",
                inline=False)
            await msg.edit(embed=embed, view=ReviewView(
                self.bot, review["id"], lang, disabled=True))
        except (discord.NotFound, discord.Forbidden, discord.HTTPException):
            log.warning("Could not disable alert buttons for review #%s",
                        review["id"])

    async def _send_evidence(self, interaction: discord.Interaction,
                             review: dict, lang: str) -> None:
        t = self.bot.i18n.t
        embed = discord.Embed(
            title=t(lang, "review.evidence_title", id=review["id"]),
            color=discord.Color.blurple(), timestamp=utcnow())
        evidence = review.get("evidence") or []
        embed.description = "\n".join(
            f"`{i}.` {e}" for i, e in enumerate(evidence, 1))[:3900] or "—"
        history = review.get("history") or []
        if history:
            embed.add_field(name=t(lang, "review.history"),
                            value=self._history_text(history, limit=15),
                            inline=False)
        timeline = review.get("timeline") or []
        if timeline:
            embed.add_field(
                name=t(lang, "review.timeline"),
                value="\n".join(
                    f"`{(ev.get('at') or '')[:16].replace('T', ' ')}` — "
                    f"{ev.get('what', '—')}" for ev in timeline[:12])[:1024],
                inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    # ── mod-log embed helper (shared with the modlogs cog) ───

    async def _modlog_embed(
        self, guild: discord.Guild, title_key: str, *, user: str | None,
        user_id: int | None, moderator: discord.Member | None,
        reason: str | None, lang: str, evidence: str | None = None,
        channel_name: str | None = None,
    ) -> None:
        gs = await self.bot.guardian_store.get_settings(guild.id)
        if not gs.get("enable_modlog", 1):
            return
        cid = gs.get("modlog_channel_id")
        channel = guild.get_channel(int(cid)) if cid else None
        if channel is None:
            channel = discord.utils.get(guild.text_channels, name="mod-logs")
        if channel is None:
            return
        t = self.bot.i18n.t
        embed = discord.Embed(title=t(lang, title_key),
                              color=discord.Color.dark_red(),
                              timestamp=utcnow())
        embed.add_field(name=t(lang, "log.field.user"),
                        value=f"{user or '—'} (`{user_id or '—'}`)", inline=True)
        embed.add_field(name=t(lang, "log.field.moderator"),
                        value=moderator.mention if moderator else "🤖 Forge Guardian",
                        inline=True)
        if channel_name:
            embed.add_field(name=t(lang, "log.field.channel"),
                            value=f"#{channel_name}", inline=True)
        embed.add_field(name=t(lang, "log.field.reason"),
                        value=(reason or "—")[:1024], inline=False)
        if evidence:
            embed.add_field(name=t(lang, "log.field.evidence"),
                            value=evidence[:1024], inline=False)
        embed.set_footer(text="Forge Guardian • Moderation Log")
        try:
            await channel.send(embed=embed)
        except (discord.Forbidden, discord.HTTPException):
            pass
