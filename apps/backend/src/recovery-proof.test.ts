import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoCompletedSuccessfully, demoCompletedSuccessfullyWithReplayLedger, type DemoEvent } from "./demo.js";
import { DEMO_SENTINEL_PUBLIC_KEY, verifyRecoveryReceiptEvent } from "./recovery-proof.js";
import { ReceiptReplayLedger } from "./receipt-replay.js";

const seed = Buffer.alloc(32, 42);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const domain = {
  network: "sandbox",
  deployment: "phase7-proof-test",
  core_id: "core.test",
  vault_id: "vault.test",
  agent_id: "agent.test",
  task_id: "task.test",
  execution_id: "exec.test",
  code_digest: "11".repeat(32),
  policy_digest: "22".repeat(32),
};
const evidence = {
  task_id: domain.task_id,
  settlement_reference: "payment-1",
  outcome: "Succeeded",
  recipient: "recipient.test",
  amount: "1000000000000000000000000",
  execution_epoch: 1,
  block_height: 123,
  block_hash: "sandbox-final-block-hash",
};

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
}

function borshU64(value: string): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function createEvents(overrides: { settlementReference?: string; checkpointHash?: string } = {}): DemoEvent[] {
  const checkpointHash = overrides.checkpointHash ?? "aa".repeat(32);
  const settlementReference = overrides.settlementReference ?? evidence.settlement_reference;
  const observedEvidence = { ...evidence, settlement_reference: settlementReference };
  const evidenceHash = createHash("sha256").update(JSON.stringify(observedEvidence)).digest("hex");
  const issuedAt = BigInt(Date.now()) * 1_000_000n - 1_000_000_000n;
  const body = {
    domain,
    task_id: domain.task_id,
    primary_identity: "33".repeat(32),
    backup_identity: "44".repeat(32),
    checkpoint_hash: checkpointHash,
    epoch_from: "0",
    epoch_to: "1",
    settlement_reference: settlementReference,
    settlement_outcome: "Succeeded",
    settlement_evidence_hash: evidenceHash,
    settlement_block_height: String(evidence.block_height),
    security_revision: "0",
    nonce: "2",
    issued_at: issuedAt.toString(),
    expires_at: (issuedAt + 60_000_000_000n).toString(),
  };
  const bytes = Buffer.concat([
    Buffer.from("NEAR_PHOENIX_RECOVERY_RECEIPT_V1\0"),
    ...Object.values(domain).map(borshString),
    borshString(body.task_id),
    borshString(body.primary_identity),
    borshString(body.backup_identity),
    borshString(body.checkpoint_hash),
    borshU64(body.epoch_from),
    borshU64(body.epoch_to),
    borshString(body.settlement_reference),
    Buffer.from([0]),
    borshString(body.settlement_evidence_hash),
    borshU64(body.settlement_block_height),
    borshU64(body.security_revision),
    borshU64(body.nonce),
    borshU64(body.issued_at),
    borshU64(body.expires_at),
  ]);
  const signature = sign(null, bytes, privateKey).toString("hex");
  const required = [
    "sandbox_configured", "primary_heartbeat", "checkpoint_committed", "primary_failed",
    "backup_restored", "payment_settled", "duplicate_payment_prevented",
    "recovery_receipt_verified", "guardian_warning", "suspicious_payment_rejected",
    "guardian_quarantined", "demo_complete",
  ];
  const events: DemoEvent[] = required.map((kind, index) => ({
    id: index + 1,
    at: "2026-11-09T00:00:00.000Z",
    kind,
    details: {},
  }));
  const update = (kind: string, details: Record<string, unknown>) => {
    const event = events.find(item => item.kind === kind)!;
    event.details = details;
  };
  update("sandbox_configured", {
    network: "sandbox", deployment: domain.deployment, core_id: domain.core_id,
    vault_id: domain.vault_id, agent_id: domain.agent_id, task_id: domain.task_id,
    sentinel_account: "sentinel.test", sentinel_public_key: DEMO_SENTINEL_PUBLIC_KEY,
  });
  update("primary_heartbeat", { epoch: 0, worker: body.primary_identity });
  update("checkpoint_committed", { digest: checkpointHash });
  update("primary_failed", { epoch: 0, checkpoint: checkpointHash });
  update("backup_restored", { epoch: 1, worker: body.backup_identity, checkpoint: checkpointHash });
  update("payment_settled", {
    operation_id: evidence.settlement_reference, outcome: "Paid", epoch: 1,
    recipient: evidence.recipient, amount: evidence.amount,
  });
  update("duplicate_payment_prevented", {
    operation_id: evidence.settlement_reference, paid: evidence.amount,
  });
  const guardianEvidenceId = "55".repeat(32);
  update("guardian_warning", { decision: "Observe", score: 75 });
  update("suspicious_payment_rejected", { evidence_id: guardianEvidenceId });
  update("guardian_quarantined", {
    decision: "Quarantine", epoch: 1, task_paused: true, evidence_id: guardianEvidenceId,
  });
  update("demo_complete", { complete: true, network: "sandbox", block_timestamp_ns: (issuedAt + 2_000_000_000n).toString() });
  update("recovery_receipt_verified", {
      body,
      signature,
      signing_bytes_hex: bytes.toString("hex"),
      evidence: observedEvidence,
      verified_by: "sentinel.test",
      core_id: domain.core_id,
      vault_id: domain.vault_id,
      on_chain_verified: true,
  });
  return events;
}

test("sandbox recovery success requires a pinned, evidence-bound receipt", () => {
  const events = createEvents();
  const replaySet = new Set<string>();
  assert.equal(verifyRecoveryReceiptEvent(events, replaySet), true);
  assert.equal(demoCompletedSuccessfully(0, events, new Set<string>()), true);
  assert.equal(demoCompletedSuccessfully(1, events, new Set<string>()), false);
  assert.equal(verifyRecoveryReceiptEvent(events, replaySet), false, "receipt replay must be rejected");
});

test("backend rejects future and expired receipts", () => {
  const events = createEvents();
  const body = events.find(event => event.kind === "recovery_receipt_verified")!.details.body as Record<string, string>;
  const complete = events.find(event => event.kind === "demo_complete")!;
  complete.details.block_timestamp_ns = (BigInt(body.issued_at) - 1n).toString();
  assert.equal(verifyRecoveryReceiptEvent(events), false, "chain clock before receipt issuance must fail closed");
  complete.details.block_timestamp_ns = body.expires_at;
  assert.equal(verifyRecoveryReceiptEvent(events), false, "receipt expired by the final sandbox block must fail closed");
  complete.details.block_timestamp_ns = (BigInt(body.issued_at) + 1n).toString();
  assert.equal(verifyRecoveryReceiptEvent(events), true);
});

test("receipt replay claims survive backend restart and are atomic across concurrent claimants", async t => {
  const parent = await mkdtemp(join(tmpdir(), "phoenix-replay-test-"));
  const directory = join(parent, "ledger");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const events = createEvents();
  const signature = (events.find(event => event.kind === "recovery_receipt_verified")!.details.signature) as string;
  const concurrent = await Promise.all([
    new ReceiptReplayLedger(directory).claim(signature),
    new ReceiptReplayLedger(directory).claim(signature),
  ]);
  assert.deepEqual(concurrent.sort(), [false, true]);
  assert.equal(await new ReceiptReplayLedger(directory).claim(signature), false, "a newly constructed backend ledger must reject the prior receipt");
  assert.equal(await new ReceiptReplayLedger(directory).claim("00"), false, "malformed signatures are rejected");
});

test("replay ledger refuses a directory with permissive filesystem access", async t => {
  if (process.platform === "win32") return;
  const parent = await mkdtemp(join(tmpdir(), "phoenix-replay-mode-test-"));
  const directory = join(parent, "ledger");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);
  await assert.rejects(new ReceiptReplayLedger(directory).claim("11".repeat(64)), /permissions must be private/);
});

test("success gate consumes only a verified receipt in the durable replay ledger", async t => {
  const parent = await mkdtemp(join(tmpdir(), "phoenix-demo-replay-test-"));
  const directory = join(parent, "ledger");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const events = createEvents();
  const ledger = new ReceiptReplayLedger(directory);
  const replayed = new ReceiptReplayLedger(directory);

  const invalid = structuredClone(events);
  invalid.find(event => event.kind === "recovery_receipt_verified")!.details.signature = "00".repeat(64);
  assert.equal(await demoCompletedSuccessfullyWithReplayLedger(0, invalid, ledger), false);
  assert.equal(await demoCompletedSuccessfullyWithReplayLedger(0, events, ledger), true);
  assert.equal(await demoCompletedSuccessfullyWithReplayLedger(0, events, replayed), false);
});

test("backend rejects missing, forged, and workflow-mismatched receipts", () => {
  const valid = createEvents();
  assert.equal(verifyRecoveryReceiptEvent(valid.filter(event => event.kind !== "recovery_receipt_verified")), false);

  const forged = structuredClone(valid);
  const forgedReceipt = forged.find(event => event.kind === "recovery_receipt_verified")!;
  forgedReceipt.details.signature = "00".repeat(64);
  assert.equal(verifyRecoveryReceiptEvent(forged), false);

  // This receipt is correctly signed but describes a different settlement
  // than the operation observed in the unified sandbox workflow.
  const mismatched = createEvents({ settlementReference: "different-payment" });
  assert.equal(verifyRecoveryReceiptEvent(mismatched), false);
});
