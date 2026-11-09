/** Derive dashboard metrics only from the evidence currently returned by the API. */
export function deriveEvidenceMetrics(demoEvents, securityEvents, securityVerified) {
  const failures = demoEvents.filter(event => event.kind === "primary_failed");
  const restorations = demoEvents.filter(event => event.kind === "backup_restored");
  let recoveryLatency = null;
  for (const failure of failures) {
    const restoration = restorations.find(event => event.id > failure.id);
    if (!restoration) continue;
    const start = Date.parse(failure.at);
    const end = Date.parse(restoration.at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      recoveryLatency = ((end - start) / 1000).toFixed(2);
    }
  }
  const duplicatePreventions = demoEvents.filter(event => event.kind === "duplicate_payment_prevented").length;
  const authFailureKinds = new Set(["AuthorizationFailure", "ApprovalRejected", "UnauthorizedAction"]);
  const authorizationFailures = securityVerified
    ? securityEvents.filter(event => authFailureKinds.has(event.kind)).length
    : null;
  const incidents = securityVerified
    ? securityEvents.filter(event => event.decision === "Quarantine").length
    : null;
  return {
    recoveryLatency,
    duplicatePreventions: demoEvents.length ? duplicatePreventions : null,
    authorizationFailures,
    incidents,
    recoverySuccessRate: null,
  };
}
