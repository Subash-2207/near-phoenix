import assert from "node:assert/strict";
import { deriveEvidenceMetrics } from "./evidence-metrics.mjs";

const events = [
  { id: 1, at: "2026-01-01T00:00:00.000Z", kind: "primary_failed" },
  { id: 2, at: "2026-01-01T00:00:04.250Z", kind: "backup_restored" },
  { id: 3, at: "2026-01-01T00:00:05.000Z", kind: "duplicate_payment_prevented" },
];
const verified = [
  { kind: "ApprovalRejected", decision: "Observe" },
  { kind: "SuspiciousTransfer", decision: "Quarantine" },
];

assert.deepEqual(deriveEvidenceMetrics(events, verified, true), {
  recoveryLatency: "4.25",
  duplicatePreventions: 1,
  authorizationFailures: 1,
  incidents: 1,
  recoverySuccessRate: null,
});
assert.deepEqual(deriveEvidenceMetrics([], verified, false), {
  recoveryLatency: null,
  duplicatePreventions: null,
  authorizationFailures: null,
  incidents: null,
  recoverySuccessRate: null,
});
assert.equal(deriveEvidenceMetrics(events.slice(0, 1), [], false).recoveryLatency, null);
assert.equal(deriveEvidenceMetrics(events, verified, false).authorizationFailures, null);
console.log("Evidence metrics tests passed");
