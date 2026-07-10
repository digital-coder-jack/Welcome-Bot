/**
 * security/riskEngine.js
 * ---------------------------------------------------------------------------
 * Phase 1/4 — Risk classification (Forge Guardian Security System v2.0).
 *
 * Central risk-score / threat-level logic shared by the join scan, the live
 * message monitor and the AI security engine.
 *
 * Threat levels & classification bands:
 *   0–20   SAFE
 *   21–40  LOW
 *   41–60  MEDIUM (REVIEW)
 *   61–80  HIGH
 *   81–100 CRITICAL
 *
 * The local risk score blends: identity findings, account analysis, invite
 * signals and previous history. The AI (Groq via FastAPI) provides its own
 * risk score; combineScores() merges them conservatively (max-biased).
 * ---------------------------------------------------------------------------
 */

/** Threat level metadata (colors used by Discord embeds). */
export const THREAT_LEVELS = Object.freeze({
  SAFE: { id: 'SAFE', label: '🟢 SAFE', color: 0x57f287, min: 0, max: 20 },
  LOW: { id: 'LOW', label: '🔵 LOW', color: 0x3498db, min: 21, max: 40 },
  MEDIUM: { id: 'MEDIUM', label: '🟡 MEDIUM (REVIEW)', color: 0xfee75c, min: 41, max: 60 },
  HIGH: { id: 'HIGH', label: '🟠 HIGH', color: 0xe67e22, min: 61, max: 80 },
  CRITICAL: { id: 'CRITICAL', label: '🔴 CRITICAL', color: 0xed4245, min: 81, max: 100 },
});

/**
 * Classify a 0–100 risk score into a threat level id.
 * @param {number} score
 * @returns {'SAFE'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'}
 */
export function classifyRisk(score) {
  const s = clamp(score);
  if (s <= 20) return 'SAFE';
  if (s <= 40) return 'LOW';
  if (s <= 60) return 'MEDIUM';
  if (s <= 80) return 'HIGH';
  return 'CRITICAL';
}

/** Clamp any value into the 0–100 integer range. */
export function clamp(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Get the metadata object for a threat level id (fail-safe to SAFE). */
export function threatMeta(levelId) {
  return THREAT_LEVELS[String(levelId).toUpperCase()] ?? THREAT_LEVELS.SAFE;
}

/** Map a threat level to the severity string used by Telegram alerts. */
export function threatToSeverity(levelId) {
  switch (String(levelId).toUpperCase()) {
    case 'CRITICAL': return 'critical';
    case 'HIGH': return 'high';
    case 'MEDIUM': return 'medium';
    default: return 'low';
  }
}

/**
 * Compute the LOCAL risk score for a join from all Phase-1 signals.
 *
 * @param {object} parts
 * @param {object} parts.identity  from identityAnalyzer.analyzeIdentity()
 * @param {object} parts.account   from accountAnalyzer.analyzeAccount()
 * @param {object} parts.invite    { code, inviterTag, unknown }
 * @param {object} parts.history   from securityStore.getHistorySummary()
 * @returns {{score:number, threatLevel:string, reasons:string[]}}
 */
export function computeJoinRisk({ identity, account, invite, history }) {
  const reasons = [];
  let score = 0;

  try {
    // Identity contribution (max 40).
    const identityScore = Math.min(40, identity?.score ?? 0);
    score += identityScore;
    for (const f of identity?.findings ?? []) reasons.push(f);

    // Account contribution (max 35).
    const accountScore = Math.min(35, account?.score ?? 0);
    score += accountScore;
    for (const f of account?.findings ?? []) reasons.push(f);

    // Invite contribution.
    if (invite?.unknown) {
      score += 8;
      reasons.push('Joined via unknown/untracked invite');
    }

    // History contribution.
    if (history) {
      if (history.previousBans > 0) {
        score += 30;
        reasons.push(`Previously banned ${history.previousBans} time(s)`);
      }
      if (history.previousKicks > 0) {
        score += 15;
        reasons.push(`Previously kicked ${history.previousKicks} time(s)`);
      }
      if (history.previousWarnings > 0) {
        score += Math.min(10, history.previousWarnings * 3);
        reasons.push(`${history.previousWarnings} previous warning(s)`);
      }
      if (history.rejoinCount >= 2) {
        score += 8;
        reasons.push(`Rejoined ${history.rejoinCount} time(s) (join/leave cycling)`);
      }
      if (history.lastRiskScore !== null && history.lastRiskScore >= 61) {
        score += 10;
        reasons.push(`Previous risk score was ${history.lastRiskScore} (${history.lastThreatLevel})`);
      }
    }
  } catch {
    // Fail safe: return what was accumulated.
  }

  const finalScore = clamp(score);
  return { score: finalScore, threatLevel: classifyRisk(finalScore), reasons };
}

/**
 * Merge the local score with the AI's score (max-biased blend: we never let
 * the AI *lower* a strong local signal, but it can raise the score).
 *
 * @param {number} localScore
 * @param {number|null} aiScore
 * @returns {number}
 */
export function combineScores(localScore, aiScore) {
  const local = clamp(localScore);
  if (aiScore === null || aiScore === undefined) return local;
  const ai = clamp(aiScore);
  // Max plus a small blend so agreement pushes the score slightly higher.
  return clamp(Math.max(local, ai) + Math.round(Math.min(local, ai) * 0.1));
}
