/**
 * rules.js
 * ---------------------------------------------------------------------------
 * Presentation helpers for the canonical SERVER_RULES defined in config.js.
 *
 * Keeping formatting here (rather than inline) means the rules render
 * identically in the welcome DM, the /rules-style embeds, and moderation logs.
 * ---------------------------------------------------------------------------
 */

import { SERVER_RULES } from '../config.js';

/**
 * Look up a single rule by its number.
 * @param {number} number
 * @returns {{number:number,title:string,description:string}|null}
 */
export function getRule(number) {
  return SERVER_RULES.find((r) => r.number === Number(number)) ?? null;
}

/**
 * Render a short, human-readable label for a rule number, e.g.
 *   "Rule 6 – No Toxic Behavior".
 * Falls back gracefully if the number is unknown.
 * @param {number} number
 * @returns {string}
 */
export function ruleLabel(number) {
  const rule = getRule(number);
  return rule ? `Rule ${rule.number} \u2013 ${rule.title}` : `Rule ${number}`;
}

/**
 * Render the full rule list as a numbered markdown string, suitable for a DM
 * or embed description.
 * @returns {string}
 */
export function formatRulesList() {
  return SERVER_RULES.map((r) => `**${r.number}. ${r.title}** \u2014 ${r.description}`).join('\n');
}
