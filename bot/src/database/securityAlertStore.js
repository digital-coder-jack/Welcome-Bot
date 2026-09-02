/** Durable lifecycle state for strict security approval alerts. */
import { createJsonStore } from './jsonStore.js';

const store = createJsonStore('security-alerts.json');
const FINAL_STATES = new Set(['DENIED', 'EXPIRED', 'ACTION_EXECUTED']);

export async function saveSecurityAlert(alert) {
  const data = await store.read();
  if (!data[alert.alertId]) data[alert.alertId] = { ...alert, status: 'PENDING' };
  store.flush();
  return data[alert.alertId];
}

export async function getSecurityAlert(alertId) {
  const data = await store.read();
  return data[alertId] ?? null;
}

export async function findSecurityAlertByEvent(eventId) {
  if (!eventId) return null;
  const data = await store.read();
  return Object.values(data).find((alert) => alert.eventId === eventId) ?? null;
}

/** Claim an alert for processing exactly once. */
export async function claimSecurityAlert(alertId, action) {
  const data = await store.read();
  const alert = data[alertId];
  if (!alert || alert.status !== 'PENDING') return null;
  alert.status = action === 'deny' ? 'DENIED' : 'APPROVED_PROCESSING';
  alert.processingAt = new Date().toISOString();
  store.flush();
  return { ...alert };
}

export async function resolveSecurityAlert(alertId, patch) {
  const data = await store.read();
  const alert = data[alertId];
  if (!alert || FINAL_STATES.has(alert.status)) return alert ?? null;
  Object.assign(alert, patch, { resolvedAt: new Date().toISOString() });
  store.flush();
  return { ...alert };
}

export async function expireSecurityAlert(alertId, now = Date.now()) {
  const data = await store.read();
  const alert = data[alertId];
  if (!alert || FINAL_STATES.has(alert.status)) return alert ?? null;
  if (now - alert.createdAt < alert.ttlMs) return alert;
  alert.status = 'EXPIRED';
  alert.expiredAt = new Date(now).toISOString();
  store.flush();
  return { ...alert };
}
