"""
Member Intelligence cog (v2.0) — the security data-collection pipeline.

• on_member_join    → full profile snapshot, join/rejoin counters, Telegram report
• on_member_remove  → leave record, counters, Telegram report
• on_member_update  → nickname / role / boost / timeout change history
• on_user_update    → username / global name / avatar change history
• on_presence_update→ last-seen touch (cheap, throttled)
• first startup     → batched scan of ALL existing members (imported=True,
                      welcome_sent=False, NO welcome messages)

Performance: batched DB writes, one transaction per batch, inter-batch
sleeps, zero HTTP calls during bulk scans, throttled presence updates.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING

import discord
from discord import app_commands
from discord.ext import commands

from bot.core.logging import get_logger
from bot.services.intel import reports
from bot.utils.formatting import human_age, utcnow

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("cogs.intel")

SCAN_BATCH_SIZE = 200        # members per DB transaction
SCAN_BATCH_SLEEP = 0.5       # seconds between batches (keeps loop responsive)
PRESENCE_THROTTLE = 300      # min seconds between last-seen writes per user


class MemberIntel(commands.Cog):
    """Collects and maintains permanent member intelligence records."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot
        self._scan_locks: dict[int, asyncio.Lock] = {}
        self._presence_seen: dict[tuple[int, int], float] = {}

    # ─────────────────────────────────────────────────────────
    # helpers
    # ─────────────────────────────────────────────────────────

    def _scan_lock(self, guild_id: int) -> asyncio.Lock:
        lock = self._scan_locks.get(guild_id)
        if lock is None:
            lock = self._scan_locks[guild_id] = asyncio.Lock()
        return lock

    async def _telegram_enabled(self, guild_id: int) -> bool:
        try:
            settings = await self.bot.db.get_guild_settings(guild_id)
            return bool(settings.get("enable_telegram", 1))
        except Exception:  # noqa: BLE001
            return False

    @staticmethod
    def _roles_summary(profile: dict) -> str:
        try:
            roles = json.loads(profile.get("roles_json") or "[]")
            return ", ".join(r["name"] for r in roles[:10]) or "—"
        except (ValueError, KeyError, TypeError):
            return "—"

    # ─────────────────────────────────────────────────────────
    # startup — first-run existing members scan
    # ─────────────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_ready(self) -> None:
        for guild in self.bot.guilds:
            # never block on_ready — scans run as background tasks
            asyncio.create_task(self._maybe_scan_guild(guild))

    @commands.Cog.listener()
    async def on_guild_join(self, guild: discord.Guild) -> None:
        asyncio.create_task(self._maybe_scan_guild(guild))

    async def _maybe_scan_guild(self, guild: discord.Guild) -> None:
        async with self._scan_lock(guild.id):
            try:
                state = await self.bot.intel_store.scan_state(guild.id)
                if state.get("scanned"):
                    return
                await self._scan_guild(guild)
            except Exception:  # noqa: BLE001
                log.exception("Initial member scan failed for guild %s", guild.id)

    async def _scan_guild(self, guild: discord.Guild) -> None:
        """Batched import of every existing member. No welcome messages —
        records are marked imported=True / welcome_sent=False."""
        intel = self.bot.intel_store
        collector = self.bot.profile_collector
        await intel.mark_scan_started(guild.id)
        started = time.monotonic()
        log.info("Starting initial member scan for %s (%s members)",
                 guild.name, guild.member_count)

        imported = bots = 0
        batch: list[tuple[int, dict]] = []

        try:
            # fetch_members streams via the gateway and respects rate limits
            async for member in guild.fetch_members(limit=None):
                batch.append((member.id, collector.snapshot(member)))
                bots += int(member.bot)
                if len(batch) >= SCAN_BATCH_SIZE:
                    imported += await self._flush_batch(guild.id, batch)
                    batch = []
                    await asyncio.sleep(SCAN_BATCH_SLEEP)
            if batch:
                imported += await self._flush_batch(guild.id, batch)
        except discord.HTTPException:
            # partial import is fine — retried on next startup (scanned stays 0)
            log.exception("Member fetch interrupted for %s — will retry "
                          "on next startup", guild.name)
            return

        # initialise join counters for imported rows that have none yet
        await self.bot.db.execute(
            "UPDATE user_profiles SET join_count = 1 "
            "WHERE guild_id = ? AND imported = 1 AND join_count = 0",
            (guild.id,))
        await intel.mark_scan_finished(guild.id, imported)

        duration = time.monotonic() - started
        log.info("Scan complete for %s: %d members in %.1fs",
                 guild.name, imported, duration)

        if await self._telegram_enabled(guild.id):
            await self.bot.telegram.send(
                reports.scan_report({
                    "server_name": guild.name,
                    "imported": imported,
                    "bots": bots,
                    "humans": imported - bots,
                    "duration": f"{duration:.1f}s",
                }),
                event_type="intel_scan", guild_id=guild.id,
            )

    async def _flush_batch(self, guild_id: int,
                           batch: list[tuple[int, dict]]) -> int:
        n = await self.bot.intel_store.bulk_import_profiles(guild_id, batch)
        # one lifecycle event per imported member (single transaction)
        conn = self.bot.db.conn
        now = utcnow().isoformat()
        await conn.executemany(
            "INSERT INTO member_events "
            "(guild_id, user_id, username, event_type, detail, occurred_at) "
            "VALUES (?, ?, ?, 'import', 'initial scan', ?)",
            [(guild_id, uid, data.get("username"), now) for uid, data in batch],
        )
        await conn.commit()
        return n

    # ─────────────────────────────────────────────────────────
    # join / rejoin
    # ─────────────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        try:
            await self._handle_join(member)
        except Exception:  # noqa: BLE001 — never break other join listeners
            log.exception("Intel join handler failed for %s", member.id)

    async def _handle_join(self, member: discord.Member) -> None:
        guild = member.guild
        intel = self.bot.intel_store

        existing = await intel.get_profile(guild.id, member.id)
        is_rejoin = bool(existing and (existing.get("leave_count") or 0) > 0)

        # full snapshot including banner/accent (one extra fetch_user call)
        data = await self.bot.profile_collector.snapshot_full(member)
        await intel.upsert_profile(guild.id, member.id, data,
                                   track_changes=bool(existing))
        await intel.set_profile_fields(guild.id, member.id, in_guild=1)
        await intel.bump_counter(guild.id, member.id, "join_count")
        if is_rejoin:
            await intel.bump_counter(guild.id, member.id, "rejoin_count")
        await intel.add_member_event(
            guild.id, member.id, str(member),
            "rejoin" if is_rejoin else "join",
            detail=f"account age: {human_age(member.created_at)}")

        # carry invite attribution over from the welcome cog's member record
        await asyncio.sleep(3)  # welcome cog persists invite data first
        member_row = await self.bot.db.get_member(guild.id, member.id) or {}
        if member_row.get("invite_code"):
            await intel.set_profile_fields(
                guild.id, member.id,
                invite_code=member_row.get("invite_code"),
                inviter_id=member_row.get("inviter_id"))

        if await self._telegram_enabled(guild.id):
            profile = await intel.get_profile(guild.id, member.id) or {}
            flags = "—"
            try:
                flags = ", ".join(
                    json.loads(profile.get("public_flags_json") or "[]")) or "—"
            except ValueError:
                pass
            await self.bot.telegram.send(
                reports.user_detected({
                    "title": ("🔄 Member Rejoined" if is_rejoin
                              else "👤 New User Detected"),
                    "username": str(member),
                    "display_name": member.display_name,
                    "user_id": member.id,
                    "created": member.created_at.strftime("%Y-%m-%d %H:%M UTC")
                               + f" ({human_age(member.created_at)})",
                    "joined": (member.joined_at or utcnow())
                              .strftime("%Y-%m-%d %H:%M UTC"),
                    "avatar": member.display_avatar.url,
                    "roles": self._roles_summary(profile),
                    "flags": flags,
                    "bot": "🤖 Yes" if member.bot else "👤 No",
                    "booster": "✅" if profile.get("is_booster") else "—",
                    "status": profile.get("status") or "unknown",
                    "imported": "✅" if profile.get("imported") else "❌",
                    "rejoined": "✅" if is_rejoin else "❌",
                    "join_count": profile.get("join_count") or 1,
                    "leave_count": profile.get("leave_count") or 0,
                    "server_name": guild.name,
                }),
                event_type="intel_join", guild_id=guild.id, user_id=member.id,
            )

    # ─────────────────────────────────────────────────────────
    # leave
    # ─────────────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member) -> None:
        try:
            await self._handle_leave(member)
        except Exception:  # noqa: BLE001
            log.exception("Intel leave handler failed for %s", member.id)

    async def _handle_leave(self, member: discord.Member) -> None:
        guild = member.guild
        intel = self.bot.intel_store

        profile = await intel.get_profile(guild.id, member.id)
        if profile is None:
            # user we never recorded (edge case) — create a minimal row
            # (Member proxies all User attributes, so snapshot_user works)
            await intel.upsert_profile(
                guild.id, member.id,
                self.bot.profile_collector.snapshot_user(member),  # type: ignore[arg-type]
                track_changes=False)

        await intel.bump_counter(guild.id, member.id, "leave_count")
        await intel.set_profile_fields(guild.id, member.id, in_guild=0)
        await intel.add_member_event(
            guild.id, member.id, str(member), "leave",
            detail=f"roles: {', '.join(r.name for r in member.roles[1:])[:200] or '—'}")

        if await self._telegram_enabled(guild.id):
            joined = member.joined_at
            duration = human_age(joined) if joined else "unknown"
            fresh = await intel.get_profile(guild.id, member.id) or {}
            await self.bot.telegram.send(
                reports.member_left({
                    "username": str(member),
                    "user_id": member.id,
                    "joined": joined.strftime("%Y-%m-%d %H:%M UTC")
                              if joined else "unknown",
                    "duration": duration,
                    "roles": ", ".join(
                        r.name for r in member.roles[1:])[:200] or "—",
                    "join_count": fresh.get("join_count") or "?",
                    "leave_count": fresh.get("leave_count") or "?",
                    "server_name": guild.name,
                }),
                event_type="intel_leave", guild_id=guild.id, user_id=member.id,
            )

    # ─────────────────────────────────────────────────────────
    # profile / member updates → change history
    # ─────────────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_member_update(self, before: discord.Member,
                               after: discord.Member) -> None:
        """Guild-level changes: nickname, roles, boost, timeout."""
        try:
            changes = await self.bot.intel_store.upsert_profile(
                after.guild.id, after.id,
                self.bot.profile_collector.snapshot(after),
                track_changes=True,
            )
            if changes:
                await self._report_changes(after.guild, after, changes)
        except Exception:  # noqa: BLE001
            log.exception("Intel member-update failed for %s", after.id)

    @commands.Cog.listener()
    async def on_user_update(self, before: discord.User,
                             after: discord.User) -> None:
        """Global changes: username, global name, avatar — applies to every
        mutual guild's record."""
        try:
            for guild in self.bot.guilds:
                member = guild.get_member(after.id)
                if member is None:
                    continue
                changes = await self.bot.intel_store.upsert_profile(
                    guild.id, after.id,
                    self.bot.profile_collector.snapshot(member),
                    track_changes=True,
                )
                if changes:
                    await self._report_changes(guild, member, changes)
        except Exception:  # noqa: BLE001
            log.exception("Intel user-update failed for %s", after.id)

    async def _report_changes(self, guild: discord.Guild,
                              member: discord.Member,
                              changes: list[dict]) -> None:
        # roles_json diffs are noisy — summarise instead of dumping JSON
        display: list[dict] = []
        for ch in changes:
            if ch["field"] == "roles_json":
                display.append({"field": "roles", "old": "(updated)",
                                "new": "(see /intel profile)"})
            else:
                display.append(ch)
        if await self._telegram_enabled(guild.id):
            await self.bot.telegram.send(
                reports.profile_changed({
                    "username": str(member), "user_id": member.id,
                    "changes": display, "server_name": guild.name,
                }),
                event_type="intel_update", guild_id=guild.id, user_id=member.id,
            )

    # ─────────────────────────────────────────────────────────
    # presence → last_seen (throttled; requires presence intent)
    # ─────────────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_presence_update(self, before: discord.Member,
                                 after: discord.Member) -> None:
        key = (after.guild.id, after.id)
        now = time.monotonic()
        if now - self._presence_seen.get(key, 0.0) < PRESENCE_THROTTLE:
            return
        self._presence_seen[key] = now
        try:
            await self.bot.intel_store.touch_last_seen(after.guild.id, after.id)
        except Exception:  # noqa: BLE001
            log.exception("last_seen update failed for %s", after.id)

    # message activity is also a "last seen" signal (works without presence intent)
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.guild is None or message.author.bot:
            return
        key = (message.guild.id, message.author.id)
        now = time.monotonic()
        if now - self._presence_seen.get(key, 0.0) < PRESENCE_THROTTLE:
            return
        self._presence_seen[key] = now
        try:
            await self.bot.intel_store.touch_last_seen(
                message.guild.id, message.author.id)
        except Exception:  # noqa: BLE001
            pass

    # ─────────────────────────────────────────────────────────
    # /intel slash commands (admin utilities)
    # ─────────────────────────────────────────────────────────

    intel_group = app_commands.Group(
        name="intel", description="Member intelligence database",
        default_permissions=discord.Permissions(administrator=True),
        guild_only=True)

    @intel_group.command(name="profile", description="Show a member's full intelligence record")
    @app_commands.describe(member="Member to look up")
    async def profile(self, interaction: discord.Interaction,
                      member: discord.Member) -> None:
        assert interaction.guild is not None
        p = await self.bot.intel_store.get_profile(
            interaction.guild.id, member.id)
        if p is None:
            await interaction.response.send_message(
                "ℹ️ No record yet for that member.", ephemeral=True)
            return
        flags = "—"
        try:
            flags = ", ".join(
                json.loads(p.get("public_flags_json") or "[]")) or "—"
        except ValueError:
            pass
        embed = discord.Embed(
            title=f"🗂 Intelligence Record — {member}",
            color=discord.Color.dark_teal(), timestamp=utcnow())
        embed.set_thumbnail(url=member.display_avatar.url)
        embed.add_field(name="User ID", value=f"`{member.id}`", inline=True)
        embed.add_field(name="Global Name",
                        value=p.get("global_name") or "—", inline=True)
        embed.add_field(name="Nickname",
                        value=p.get("nickname") or "—", inline=True)
        embed.add_field(name="Created",
                        value=(p.get("account_created_at") or "—")[:10], inline=True)
        embed.add_field(name="Joined",
                        value=(p.get("joined_at") or "—")[:10], inline=True)
        embed.add_field(name="Highest Role",
                        value=p.get("highest_role") or "—", inline=True)
        embed.add_field(name="Badges", value=flags[:200], inline=False)
        embed.add_field(
            name="Lifecycle",
            value=(f"Joins `{p.get('join_count', 0)}` · "
                   f"Leaves `{p.get('leave_count', 0)}` · "
                   f"Rejoins `{p.get('rejoin_count', 0)}`"),
            inline=True)
        embed.add_field(
            name="Flags",
            value=(f"Imported {'✅' if p.get('imported') else '❌'} · "
                   f"Welcomed {'✅' if p.get('welcome_sent') else '❌'} · "
                   f"Booster {'✅' if p.get('is_booster') else '—'}"),
            inline=True)
        embed.add_field(
            name="Last Seen", value=(p.get("last_seen") or "—")[:19], inline=True)
        if p.get("security_notes"):
            embed.add_field(name="📝 Security Notes",
                            value=p["security_notes"][:500], inline=False)
        embed.set_footer(text="Collected via official Discord Bot API only")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @intel_group.command(name="history", description="Show a member's profile change history")
    @app_commands.describe(member="Member to look up")
    async def history(self, interaction: discord.Interaction,
                      member: discord.Member) -> None:
        assert interaction.guild is not None
        rows = await self.bot.intel_store.get_history(
            interaction.guild.id, member.id, limit=15)
        if not rows:
            await interaction.response.send_message(
                "ℹ️ No recorded changes for that member.", ephemeral=True)
            return
        lines = [
            f"`{(r['changed_at'] or '')[:16]}` **{r['field']}**: "
            f"{(r['old_value'] or '—')[:60]} → {(r['new_value'] or '—')[:60]}"
            for r in rows
        ]
        embed = discord.Embed(
            title=f"📜 Change History — {member}",
            description="\n".join(lines)[:4000],
            color=discord.Color.dark_teal())
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @intel_group.command(name="note", description="Attach a security note to a member's record")
    @app_commands.describe(member="Member", note="The note to store")
    async def note(self, interaction: discord.Interaction,
                   member: discord.Member, note: str) -> None:
        assert interaction.guild is not None
        intel = self.bot.intel_store
        p = await intel.get_profile(interaction.guild.id, member.id)
        if p is None:
            await intel.upsert_profile(
                interaction.guild.id, member.id,
                self.bot.profile_collector.snapshot(member),
                track_changes=False)
        stamp = utcnow().strftime("%Y-%m-%d")
        existing = (p or {}).get("security_notes") or ""
        combined = (existing + f"\n[{stamp} {interaction.user}] {note}").strip()
        await intel.set_profile_fields(
            interaction.guild.id, member.id, security_notes=combined[:2000])
        await interaction.response.send_message(
            f"📝 Note added to **{member}**'s record.", ephemeral=True)

    @intel_group.command(name="rescan", description="Force a full member re-scan (updates all records)")
    async def rescan(self, interaction: discord.Interaction) -> None:
        assert interaction.guild is not None
        guild = interaction.guild
        if self._scan_lock(guild.id).locked():
            await interaction.response.send_message(
                "⏳ A scan is already running.", ephemeral=True)
            return
        await interaction.response.send_message(
            f"🗂 Re-scanning **{guild.member_count}** members in the "
            f"background — you'll get a Telegram report when done.",
            ephemeral=True)

        async def _run() -> None:
            async with self._scan_lock(guild.id):
                try:
                    await self._scan_guild(guild)
                except Exception:  # noqa: BLE001
                    log.exception("Manual rescan failed for %s", guild.id)

        asyncio.create_task(_run())

    @intel_group.command(name="stats", description="Intelligence database statistics")
    async def stats(self, interaction: discord.Interaction) -> None:
        assert interaction.guild is not None
        gid = interaction.guild.id
        db = self.bot.db
        total = await self.bot.intel_store.profile_count(gid)
        row_in = await db.fetchone(
            "SELECT COUNT(*) AS n FROM user_profiles "
            "WHERE guild_id = ? AND in_guild = 1", (gid,))
        row_imp = await db.fetchone(
            "SELECT COUNT(*) AS n FROM user_profiles "
            "WHERE guild_id = ? AND imported = 1", (gid,))
        row_ev = await db.fetchone(
            "SELECT COUNT(*) AS n FROM member_events WHERE guild_id = ?", (gid,))
        row_ch = await db.fetchone(
            "SELECT COUNT(*) AS n FROM profile_history WHERE guild_id = ?", (gid,))
        state = await self.bot.intel_store.scan_state(gid)
        await interaction.response.send_message(
            f"🗂 **Member Intelligence — {interaction.guild.name}**\n"
            f"• Records: `{total}` (`{row_in['n'] if row_in else 0}` currently in server)\n"
            f"• Imported by initial scan: `{row_imp['n'] if row_imp else 0}`\n"
            f"• Lifecycle events: `{row_ev['n'] if row_ev else 0}`\n"
            f"• Profile changes tracked: `{row_ch['n'] if row_ch else 0}`\n"
            f"• Initial scan: {'✅ complete' if state.get('scanned') else '⏳ pending'}",
            ephemeral=True)


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(MemberIntel(bot))
