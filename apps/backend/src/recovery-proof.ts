import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";

export interface RecoveryProofEvent {
  kind: string;
  details: Record<string, unknown>;
}

// The local Phase 7 sandbox uses a deterministic SENTINEL key. Only the public
// half is pinned here; the private seed exists solely in the local test harness.
export const DEMO_SENTINEL_PUBLIC_KEY = "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61";
const RECEIPT_PREFIX = Buffer.from("NEAR_PHOENIX_RECOVERY_RECEIPT_V1\0", "utf8");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const U64_MAX = (1n << 64n) - 1n;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function decimal(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed <= U64_MAX ? value : undefined;
  } catch { return undefined; }
}

function borshString(value: unknown): Buffer {
  if (typeof value !== "string") throw new Error("Receipt string field is missing");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 0xffff_ffff) throw new Error("Receipt string field is too long");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function borshU64(value: unknown): Buffer {
  const text = decimal(value);
  if (!text) throw new Error("Receipt u64 field is invalid");
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(text));
  return bytes;
}

function signingBytes(bodyValue: unknown): Buffer {
  const body = record(bodyValue);
  const domain = record(body?.domain);
  if (!body || !domain) throw new Error("Receipt body or domain is missing");
  const strings = [
    domain.network, domain.deployment, domain.core_id, domain.vault_id,
    domain.agent_id, domain.task_id, domain.execution_id, domain.code_digest,
    domain.policy_digest, body.task_id, body.primary_identity, body.backup_identity,
    body.checkpoint_hash,
  ];
  const fields = strings.map(borshString);
  fields.push(
    borshU64(body.epoch_from),
    borshU64(body.epoch_to),
    borshString(body.settlement_reference),
  );
  if (body.settlement_outcome !== "Succeeded") throw new Error("Unsupported settlement outcome");
  fields.push(Buffer.from([0])); // VerifiedSettlementOutcome::Succeeded
  fields.push(
    borshString(body.settlement_evidence_hash),
    borshU64(body.settlement_block_height),
    borshU64(body.security_revision),
    borshU64(body.nonce),
    borshU64(body.issued_at),
    borshU64(body.expires_at),
  );
  return Buffer.concat([RECEIPT_PREFIX, ...fields]);
}

function unique(events: RecoveryProofEvent[], kind: string): RecoveryProofEvent | undefined {
  const matches = events.filter(event => event.kind === kind);
  return matches.length === 1 ? matches[0] : undefined;
}

function hashEvidence(value: unknown): string | undefined {
  const evidence = record(value);
  if (!evidence) return undefined;
  const executionEpoch = integer(evidence.execution_epoch);
  const blockHeight = integer(evidence.block_height);
  const canonical = {
    task_id: string(evidence.task_id),
    settlement_reference: string(evidence.settlement_reference),
    outcome: string(evidence.outcome),
    recipient: string(evidence.recipient),
    amount: string(evidence.amount),
    execution_epoch: executionEpoch,
    block_height: blockHeight,
    block_hash: string(evidence.block_hash),
  };
  if (Object.values(canonical).some(item => item === undefined)) return undefined;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Verify the SENTINEL signature and bind the receipt to the sandbox observations. */
export function verifyRecoveryReceiptEvent(
  events: RecoveryProofEvent[],
  replayedSignatures: Set<string> = new Set(),
  expectedPublicKey = DEMO_SENTINEL_PUBLIC_KEY,
): boolean {
  try {
    const configured = unique(events, "sandbox_configured");
    const heartbeat = unique(events, "primary_heartbeat");
    const checkpoint = unique(events, "checkpoint_committed");
    const failure = unique(events, "primary_failed");
    const restored = unique(events, "backup_restored");
    const settlement = unique(events, "payment_settled");
    const duplicate = unique(events, "duplicate_payment_prevented");
    const receiptEvent = unique(events, "recovery_receipt_verified");
    const warning = unique(events, "guardian_warning");
    const suspicious = unique(events, "suspicious_payment_rejected");
    const quarantine = unique(events, "guardian_quarantined");
    const complete = unique(events, "demo_complete");
    const config = record(configured?.details);
    const receiptDetails = record(receiptEvent?.details);
    const body = record(receiptDetails?.body);
    const domain = record(body?.domain);
    const evidence = record(receiptDetails?.evidence);
    if (!config || !body || !domain || !evidence || !heartbeat || !checkpoint || !failure
      || !restored || !settlement || !duplicate || !warning || !suspicious || !quarantine || !complete) return false;

    const requiredOrder = [
      "sandbox_configured", "primary_heartbeat", "checkpoint_committed", "primary_failed",
      "backup_restored", "payment_settled", "duplicate_payment_prevented",
      "recovery_receipt_verified", "guardian_warning", "suspicious_payment_rejected",
      "guardian_quarantined", "demo_complete",
    ];
    let previousIndex = -1;
    for (const kind of requiredOrder) {
      const index = events.findIndex(event => event.kind === kind);
      if (index <= previousIndex) return false;
      previousIndex = index;
    }

    const configuredKey = string(config.sentinel_public_key);
    const verifiedBy = string(receiptDetails?.verified_by);
    const signature = string(receiptDetails?.signature);
    if (configuredKey !== expectedPublicKey || !verifiedBy || verifiedBy !== config.sentinel_account) return false;
    if (receiptDetails?.on_chain_verified !== true) return false;
    if (!/^[0-9a-f]{128}$/.test(signature ?? "")) return false;
    if (replayedSignatures.has(signature!)) return false;

    const bodyNetwork = string(domain.network);
    if (bodyNetwork !== "sandbox"
      || domain.deployment !== config.deployment
      || domain.core_id !== config.core_id
      || domain.vault_id !== config.vault_id
      || domain.agent_id !== config.agent_id
      || domain.task_id !== config.task_id
      || body.task_id !== config.task_id
      || receiptDetails?.core_id !== config.core_id
      || receiptDetails?.vault_id !== config.vault_id) return false;

    const checkpointDetails = record(checkpoint.details);
    const failureDetails = record(failure.details);
    const restoredDetails = record(restored.details);
    const heartbeatDetails = record(heartbeat.details);
    const settlementDetails = record(settlement.details);
    const duplicateDetails = record(duplicate.details);
    const warningDetails = record(warning.details);
    const suspiciousDetails = record(suspicious.details);
    const quarantineDetails = record(quarantine.details);
    const completeDetails = record(complete.details);
    if (!checkpointDetails || !failureDetails || !restoredDetails || !heartbeatDetails
      || !settlementDetails || !duplicateDetails || !warningDetails || !suspiciousDetails || !quarantineDetails || !completeDetails) return false;
    if (body.primary_identity !== heartbeatDetails.worker
      || heartbeatDetails.epoch !== 0
      || body.backup_identity !== restoredDetails.worker
      || restoredDetails.epoch !== 1
      || body.checkpoint_hash !== checkpointDetails.digest
      || body.checkpoint_hash !== restoredDetails.checkpoint
      || failureDetails.epoch !== 0
      || failureDetails.checkpoint !== body.checkpoint_hash
      || body.settlement_reference !== settlementDetails.operation_id
      || duplicateDetails.operation_id !== body.settlement_reference
      || duplicateDetails.paid !== settlementDetails.amount
      || body.settlement_outcome !== "Succeeded"
      || settlementDetails.outcome !== "Paid"
      || settlementDetails.epoch !== 1
      || string(body.epoch_from) !== "0"
      || string(body.epoch_to) !== "1"
      || warningDetails.decision !== "Observe"
      || suspiciousDetails.evidence_id !== quarantineDetails.evidence_id
      || quarantineDetails.decision !== "Quarantine"
      || quarantineDetails.epoch !== 1
      || quarantineDetails.task_paused !== true) return false;

    const evidenceHash = hashEvidence(evidence);
    if (!evidenceHash || evidenceHash !== body.settlement_evidence_hash
      || evidence.task_id !== body.task_id
      || evidence.settlement_reference !== body.settlement_reference
      || evidence.outcome !== body.settlement_outcome
      || evidence.block_height !== Number(body.settlement_block_height)
      || evidence.execution_epoch !== 1
      || evidence.recipient !== settlementDetails.recipient
      || evidence.amount !== settlementDetails.amount) return false;

    const issuedAt = decimal(body.issued_at);
    const expiresAt = decimal(body.expires_at);
    const nonce = decimal(body.nonce);
    const verifiedBlockTimestamp = decimal(completeDetails.block_timestamp_ns);
    if (!issuedAt || !expiresAt || !nonce || BigInt(expiresAt) <= BigInt(issuedAt)
      || BigInt(expiresAt) - BigInt(issuedAt) > 60_000_000_000n
      || !verifiedBlockTimestamp || BigInt(issuedAt) > BigInt(verifiedBlockTimestamp)
      || BigInt(expiresAt) <= BigInt(verifiedBlockTimestamp)
      || nonce !== "2") return false;

    const bytes = signingBytes(body);
    const reportedBytes = string(receiptDetails?.signing_bytes_hex);
    if (!reportedBytes || reportedBytes !== bytes.toString("hex")) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(expectedPublicKey, "hex")]),
      format: "der",
      type: "spki",
    });
    if (!verifyEd25519(null, bytes, publicKey, Buffer.from(signature!, "hex"))) return false;
    replayedSignatures.add(signature!);
    return true;
  } catch {
    return false;
  }
}
