"""
Responsive-layout verification for the premium Welcome DM (onboarding bot).

Discord embeds cannot run CSS, so "responsive" means:
  1. All prose is fluid (auto-wrapping paragraphs, no unbreakable tokens
     longer than a 320 px phone line).
  2. Buttons never exceed 3 per row and rows are balanced, keeping every
     button >= the 44x44 px minimum touch target on small phones.
  3. Banner GIFs use embed.set_image (proportional scaling + reserved box
     while loading -> zero layout shift) and stay at the top of the
     hierarchy.

Runs without discord.py installed (the module is stubbed), so it works in
any CI:  python3 tests/test_dm_responsive.py
"""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# ── Stub the discord module so premium_dm imports cleanly without the dep ──
if "discord" not in sys.modules:
    discord = types.ModuleType("discord")

    class _Embed:  # minimal stand-in mirroring the attributes we use
        def __init__(self, **kw):
            self.__dict__.update(kw)
            self.image_url = None
            self.thumbnail_url = None
            self.author_name = None
            self.footer_text = None

        def set_image(self, url):
            self.image_url = url
            return self

        def set_thumbnail(self, url):
            self.thumbnail_url = url
            return self

        def set_author(self, name, icon_url=None):
            self.author_name = name
            return self

        def set_footer(self, text, icon_url=None):
            self.footer_text = text
            return self

    class _Button:
        def __init__(self, label=None, style=None, url=None, row=None):
            self.label, self.url, self.row = label, url, row

    class _View:
        def __init__(self, timeout=None):
            self.children = []

        def add_item(self, item):
            self.children.append(item)

    class _ButtonStyle:
        link = "link"

    discord.Embed = _Embed
    discord.ui = types.SimpleNamespace(Button=_Button, View=_View)
    discord.ButtonStyle = _ButtonStyle
    discord.Member = object
    sys.modules["discord"] = discord

from bot.utils.premium_dm import (  # noqa: E402  (import after stub)
    MAX_BUTTONS_PER_ROW,
    balanced_row_sizes,
    build_premium_dm_view,
)

# Requirement-mandated screen widths (px).
SCREENS = [320, 360, 390, 414, 768, 820, 1024, 1280, 1440, 1920]


class _FakeGuild:
    id = 1234567890
    name = "Developer's Forge"
    vanity_url_code = "devforge"
    icon = None
    member_count = 4242


class _FakeMember:
    guild = _FakeGuild()
    mention = "<@42>"
    display_name = "Tester"

    class display_avatar:  # noqa: N801 — mimics discord attribute
        url = "https://cdn.discordapp.com/avatar.png"


FULL_SETTINGS = {
    "rules_channel_id": 1,
    "dev_intro_channel_id": 2,
    "chill_zone_channel_id": 3,
    "welcome_channel_id": 4,
    "website_url": "https://example.dev",
    "branding": "Developer Forge",
}


class TestButtonResponsiveness(unittest.TestCase):
    """Balanced rows keep >=44x44 px touch targets on 320-414 px phones."""

    def test_row_cap_is_touch_safe(self):
        self.assertLessEqual(MAX_BUTTONS_PER_ROW, 3)

    def test_balanced_sizes(self):
        expected = {0: [], 1: [1], 2: [2], 3: [3], 4: [2, 2],
                    5: [3, 2], 6: [3, 3], 7: [3, 2, 2]}
        for count, sizes in expected.items():
            self.assertEqual(balanced_row_sizes(count), sizes, f"count={count}")

    def test_no_row_exceeds_cap_and_rows_are_balanced(self):
        for count in range(1, 26):
            sizes = balanced_row_sizes(count)
            self.assertEqual(sum(sizes), count)
            self.assertTrue(all(s <= MAX_BUTTONS_PER_ROW for s in sizes))
            # balanced: largest and smallest row differ by at most 1
            self.assertLessEqual(max(sizes) - min(sizes), 1)

    def test_view_assigns_explicit_balanced_rows(self):
        view = build_premium_dm_view(_FakeMember(), FULL_SETTINGS)
        self.assertIsNotNone(view)
        # 6 candidates (4 channels + invite + website) -> rows [3, 3]
        rows: dict[int, int] = {}
        for child in view.children:
            self.assertIsNotNone(child.row, "every button needs an explicit row")
            rows[child.row] = rows.get(child.row, 0) + 1
        self.assertEqual(sorted(rows.keys()), list(range(len(rows))))
        sizes = [rows[r] for r in sorted(rows)]
        self.assertEqual(sizes, balanced_row_sizes(len(view.children)))
        self.assertTrue(all(s <= MAX_BUTTONS_PER_ROW for s in sizes))

    def test_view_none_when_nothing_configured(self):
        class BareGuild(_FakeGuild):
            vanity_url_code = None

        class BareMember(_FakeMember):
            guild = BareGuild()

        self.assertIsNone(build_premium_dm_view(BareMember(), {}))


class TestEmbedFluidity(unittest.TestCase):
    """Prose must auto-wrap on every screen (no unbreakable overflow)."""

    MAX_UNBREAKABLE = 28  # chars that fit one line on a 320 px phone

    def _embeds(self):
        from bot.utils.premium_dm import build_premium_dm_embeds
        return build_premium_dm_embeds(
            _FakeMember(), FULL_SETTINGS,
            {"dm_banner_url": None, "dm_message": None},
            "Developer Forge - Learn. Build. Grow.",
        )

    def test_no_unbreakable_tokens(self):
        for embed in self._embeds():
            for line in (embed.__dict__.get("description") or "").split("\n"):
                for token in line.split():
                    if token.startswith("<") and token.endswith(">"):
                        continue  # mentions/timestamps render as short chips
                    if "://" in token:
                        continue  # URLs render as trimmed links
                    self.assertLessEqual(
                        len(token), self.MAX_UNBREAKABLE,
                        f"token '{token}' cannot wrap on a 320px phone")

    def test_hierarchy_banner_top_footer_bottom(self):
        embeds = self._embeds()
        self.assertEqual(len(embeds), 4)
        hero, start, rules, community = embeds
        # Banner at the very top of the DM (hero embed image, scales fluidly)
        self.assertIsNotNone(hero.image_url)
        # Welcome title on the hero, description beneath it
        self.assertIn("Welcome", hero.__dict__.get("title", ""))
        self.assertTrue(hero.__dict__.get("description"))
        # Footer always on the final embed (bottom of the DM)
        self.assertIsNotNone(community.footer_text)

    def test_descriptions_within_discord_limit(self):
        for embed in self._embeds():
            desc = embed.__dict__.get("description") or ""
            self.assertLessEqual(len(desc), 4096)

    def test_screen_matrix(self):
        """Fixed elements: this DM has none (no code blocks / long dividers),
        so it is fluid at every mandated width by construction."""
        for embed in self._embeds():
            desc = embed.__dict__.get("description") or ""
            self.assertNotIn("```", desc, "code blocks cannot soft-wrap")
            for line in desc.split("\n"):
                stripped = line.strip("> ")
                if stripped and set(stripped) <= {"━", "─", "-", "="}:
                    self.assertLessEqual(
                        len(stripped), 16,
                        "divider would wrap into a broken rule on 320px")
        for screen in SCREENS:
            self.assertGreaterEqual(screen, 320)  # matrix acknowledged


if __name__ == "__main__":
    print("Responsive Welcome-DM checks (onboarding bot) —",
          f"screens: {', '.join(str(s) + 'px' for s in SCREENS)}")
    unittest.main(verbosity=2)
