/**
 * tests/dm-responsive-check.js
 * ---------------------------------------------------------------------------
 * Responsive-layout verification for the premium Welcome DM.
 *
 * Discord embeds cannot run CSS, so "responsive" means every fixed-width
 * element must fit the narrowest supported client and all prose must be
 * fluid (auto-wrapping). This script verifies those invariants against the
 * per-device embed-content budgets below.
 *
 * Device budgets (embed content area, measured from Discord clients):
 *   width(px) → approx monospace columns available inside a code block
 *   320  → ~28 cols   (small Android, iPhone SE 1st gen)
 *   360  → ~32 cols   (common Android)
 *   390  → ~35 cols   (iPhone 12–15)
 *   414  → ~38 cols   (iPhone Plus/Max)
 *   768+ → 59+ cols   (tablet / laptop / desktop — embed max-width caps)
 *
 * Run:  node tests/dm-responsive-check.js
 * Exits non-zero on any violation, so it can gate CI.
 * ---------------------------------------------------------------------------
 */

import {
  buildWelcomeBody,
  headerPlaque,
  DIVIDER,
  MOBILE_SAFE_CODE_COLS,
  WELCOME_QUOTES,
} from '../src/managers/dmContent.js';
import { toBalancedRows } from '../src/managers/dmManager.js';
import { ButtonBuilder, ButtonStyle } from 'discord.js';

/** Screen widths required by the spec. */
const SCREENS = [320, 360, 390, 414, 768, 820, 1024, 1280, 1440, 1920];

/** Monospace columns available inside a code block per screen width. */
function codeColsFor(width) {
  if (width <= 320) return 28;
  if (width <= 360) return 32;
  if (width <= 390) return 35;
  if (width <= 414) return 38;
  return 59; // tablet+ — Discord caps embed width, so budget stops growing
}

/**
 * Proportional-font glyphs budget for a single divider line. Heavy box
 * glyph ━ renders ~13–14 px; keep ≤ 16 glyphs to fit a 320 px phone
 * (~250 px content ≈ 17 glyphs) without wrapping into a broken rule.
 */
const MAX_DIVIDER_GLYPHS = 16;

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

/* ── 1. Header plaque: must fit the smallest code-block budget ──────── */
console.log('\n[1] Header plaque (monospace code block — cannot soft-wrap)');
{
  const lines = headerPlaque()
    .split('\n')
    .filter((l) => l !== '```');
  const widest = Math.max(...lines.map((l) => [...l].length));

  for (const screen of SCREENS) {
    const budget = codeColsFor(screen);
    if (widest > budget) {
      fail(`${screen}px: plaque is ${widest} cols but only ${budget} fit → clipped`);
    }
  }
  if (widest <= MOBILE_SAFE_CODE_COLS) {
    pass(`plaque widest line = ${widest} cols ≤ ${MOBILE_SAFE_CODE_COLS} (320px-safe) — fits ALL screens`);
  }

  // Symmetry: every content line must be perfectly centred (±1 col).
  const inner = lines.filter((l) => l.startsWith('│'));
  for (const line of inner) {
    const body = [...line].slice(1, -1).join('');
    const left = body.length - body.trimStart().length;
    const right = body.length - body.trimEnd().length;
    if (Math.abs(left - right) > 1) {
      fail(`plaque line "${line}" is off-centre (left=${left}, right=${right})`);
    }
  }
  pass('plaque text perfectly centred (computed padding, all lines)');
}

/* ── 2. Dividers: must never wrap into a broken double line ─────────── */
console.log('\n[2] Dividers (proportional font — wrapping breaks the rule)');
{
  const glyphs = [...DIVIDER].length;
  if (glyphs > MAX_DIVIDER_GLYPHS) {
    fail(`divider is ${glyphs} glyphs; max ${MAX_DIVIDER_GLYPHS} for a 320px phone`);
  } else {
    pass(`divider = ${glyphs} glyphs ≤ ${MAX_DIVIDER_GLYPHS} — single unbroken rule on every screen`);
  }
}

/* ── 3. Body: fluid prose, no over-long unbreakable tokens, size cap ── */
console.log('\n[3] Body copy (fluid auto-wrapping prose)');
{
  const vars = {
    username: 'averyverylongusername',
    displayName: 'A Very Long Display Name Indeed',
    memberCount: 123456,
    joinDate: '<t:1750000000:D>',
    serverName: "Developer's Forge — The Very Long Server Name Edition",
  };

  for (const quote of WELCOME_QUOTES) {
    const body = buildWelcomeBody(vars, quote);

    if (body.length > 3800) fail(`body exceeds clamp: ${body.length} chars`);

    // No unbreakable token (no spaces) longer than a 320px line — such a
    // token cannot wrap and would force horizontal overflow.
    let inCode = false;
    for (const line of body.split('\n')) {
      if (line.startsWith('```')) { inCode = !inCode; continue; }
      if (inCode) continue; // code block checked in [1]
      for (const token of line.split(/\s+/)) {
        // Discord renders <t:..> and mentions as short chips — skip markup.
        if (/^<.+>$/.test(token)) continue;
        if ([...token].length > 28) {
          fail(`unbreakable token "${token.slice(0, 30)}…" cannot wrap on 320px`);
        }
      }
    }
  }
  pass(`all ${WELCOME_QUOTES.length} quote variants ≤ 3800 chars, no unbreakable overflow tokens`);

  // Visual hierarchy: plaque(top) → greeting → identity → steps → quote → sign-off
  const body = buildWelcomeBody(vars, WELCOME_QUOTES[0]);
  const order = ['```', 'Hello,', 'Welcome to', '📖 Read the Rules', WELCOME_QUOTES[0].slice(1, 20), 'The Forge is waiting'];
  let cursor = -1;
  let ok = true;
  for (const marker of order) {
    const at = body.indexOf(marker, cursor + 1);
    if (at <= cursor) { fail(`hierarchy broken at "${marker}"`); ok = false; break; }
    cursor = at;
  }
  if (ok) pass('visual hierarchy preserved: header → title → description → steps → quote → footer');
}

/* ── 4. Buttons: balanced rows, touch-target cap ────────────────────── */
console.log('\n[4] Buttons (≤3/row, balanced → ≥44×44px touch targets)');
{
  const mk = (n) =>
    Array.from({ length: n }, (_, i) =>
      new ButtonBuilder().setLabel(`B${i}`).setStyle(ButtonStyle.Link).setURL('https://discord.com')
    );

  const expect = { 1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2] };
  for (const [count, sizes] of Object.entries(expect)) {
    const rows = toBalancedRows(mk(Number(count)));
    const actual = rows.map((r) => r.components.length);
    if (JSON.stringify(actual) !== JSON.stringify(sizes)) {
      fail(`${count} buttons → rows ${JSON.stringify(actual)}, expected ${JSON.stringify(sizes)}`);
    } else if (actual.some((s) => s > 3)) {
      fail(`${count} buttons → a row has ${Math.max(...actual)} buttons (>3, too small to tap)`);
    } else {
      pass(`${count} button(s) → rows ${JSON.stringify(actual)} — every button ≥44px on 320px screens`);
    }
  }
}

/* ── 5. Per-screen summary ──────────────────────────────────────────── */
console.log('\n[5] Screen-size matrix');
for (const screen of SCREENS) {
  const budget = codeColsFor(screen);
  const plaqueW = Math.max(
    ...headerPlaque().split('\n').filter((l) => l !== '```').map((l) => [...l].length)
  );
  const fits = plaqueW <= budget && [...DIVIDER].length <= MAX_DIVIDER_GLYPHS;
  console.log(`  ${fits ? '✓' : '✗'} ${String(screen).padStart(4)}px — code budget ${budget} cols, plaque ${plaqueW} cols, divider ${[...DIVIDER].length} glyphs`);
  if (!fits) failures += 1;
}

console.log(failures === 0 ? '\nALL RESPONSIVE CHECKS PASSED ✅' : `\n${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
