import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const artifactUrl = new URL("../docs/PHASE7B-E2E-EVIDENCE.json", import.meta.url);
const sandboxArtifact = JSON.parse(readFileSync(artifactUrl, "utf8"));

const REQUIRED_CHAIN_PROOF_PARTS = [
  "networkGenesisHash",
  "transactionHash",
  "rewindExecutionReceiptId",
  "transferReceiptId",
  "transferReceiptInputAndInclusionProof",
  "transferExecutionOutcome",
  "transferOutcomeMerkleProof",
  "chunkHeaderAndInclusionProof",
  "finalizedHeaderAndValidatorProof",
  "trustedCheckpoint",
  "operationStateProof",
];

function uniqueEvent(events, kind, errors) {
  const matches = events.filter((event) => event?.kind === kind);
  if (matches.length !== 1) {
    errors.push(`expected exactly one ${kind} event, got ${matches.length}`);
    return null;
  }
  return matches[0];
}

/**
 * This is deliberately a claim-consistency audit, not a NEAR proof verifier.
 * It checks whether the saved Phase 7B event claims agree with one another and
 * inventories required proof material. It never upgrades RPC/runner claims to
 * cryptographically verified evidence.
 */
export function inspectSandboxArtifact(artifact) {
  const errors = [];
  const events = Array.isArray(artifact?.events) ? artifact.events : [];
  if (artifact?.status !== "succeeded") errors.push("run status is not succeeded");

  const settlementEvent = uniqueEvent(events, "payment_settled", errors);
  const duplicateEvent = uniqueEvent(events, "duplicate_payment_prevented", errors);
  const receiptEvent = uniqueEvent(events, "recovery_receipt_verified", errors);
  const settlement = settlementEvent?.details;
  const duplicate = duplicateEvent?.details;
  const receipt = receiptEvent?.details;
  const body = receipt?.body;
  const evidence = receipt?.evidence;

  const equal = (left, right, label) => {
    if (left === undefined || right === undefined || left !== right) {
      errors.push(`${label} mismatch or missing`);
    }
  };

  if (settlement && duplicate && body && evidence) {
    equal(settlement.operation_id, duplicate.operation_id, "operation ID vs duplicate guard");
    equal(settlement.operation_id, body.settlement_reference, "operation ID vs signed receipt claim");
    equal(settlement.operation_id, evidence.settlement_reference, "operation ID vs evidence claim");
    equal(settlement.recipient, evidence.recipient, "recipient");
    equal(settlement.amount, evidence.amount, "amount");
    equal(settlement.amount, duplicate.paid, "paid amount");
    equal(settlement.amount, duplicate.recipient_balance_delta, "recipient balance delta");
    equal(String(settlement.epoch), String(evidence.execution_epoch), "execution epoch");
    equal(settlement.outcome, "Paid", "settlement event outcome");
    equal(evidence.outcome, "Succeeded", "settlement evidence outcome");
    equal(body.settlement_outcome, "Succeeded", "signed receipt outcome claim");
    equal(body.settlement_block_height, String(evidence.block_height), "settlement block height");
    equal(body.task_id, evidence.task_id, "task ID");
    equal(body.domain?.vault_id, receipt.vault_id, "REWIND account ID");
    equal(body.domain?.network, "sandbox", "receipt network");
  } else {
    errors.push("required settlement, duplicate-guard, or receipt evidence details are missing");
  }

  const proofBundle = artifact?.nearProofBundle ?? {};
  const missingProofParts = REQUIRED_CHAIN_PROOF_PARTS.filter((part) =>
    proofBundle[part] === undefined || proofBundle[part] === null,
  );

  return {
    internallyConsistent: errors.length === 0,
    consistencyErrors: errors,
    classification: "sandbox-runner-and-RPC-reported-claims",
    cryptographicallyVerified: false,
    missingProofParts,
    proofVerifierImplemented: false,
  };
}

function clonedArtifact() {
  return structuredClone(sandboxArtifact);
}

test("Phase 7B Sandbox artifact has internally matching settlement claims", () => {
  const result = inspectSandboxArtifact(sandboxArtifact);
  assert.equal(result.internallyConsistent, true, result.consistencyErrors.join("; "));
  assert.equal(result.classification, "sandbox-runner-and-RPC-reported-claims");
  assert.equal(result.cryptographicallyVerified, false);
  assert.equal(result.proofVerifierImplemented, false);
});

test("tampered amount, recipient, operation ID, or settlement block is rejected", () => {
  const mutations = [
    (artifact) => { artifact.events.find((e) => e.kind === "recovery_receipt_verified").details.evidence.amount = "1"; },
    (artifact) => { artifact.events.find((e) => e.kind === "payment_settled").details.recipient = "attacker.test.near"; },
    (artifact) => { artifact.events.find((e) => e.kind === "duplicate_payment_prevented").details.operation_id = "replayed-operation"; },
    (artifact) => { artifact.events.find((e) => e.kind === "recovery_receipt_verified").details.body.settlement_block_height = "1"; },
  ];

  for (const mutate of mutations) {
    const altered = clonedArtifact();
    mutate(altered);
    const result = inspectSandboxArtifact(altered);
    assert.equal(result.internallyConsistent, false);
    assert.ok(result.consistencyErrors.length > 0);
    assert.equal(result.cryptographicallyVerified, false);
  }
});

test("duplicated settlement or receipt claims fail the unique-event checks", () => {
  const altered = clonedArtifact();
  altered.events.push(structuredClone(altered.events.find((e) => e.kind === "payment_settled")));
  altered.events.push(structuredClone(altered.events.find((e) => e.kind === "recovery_receipt_verified")));

  const result = inspectSandboxArtifact(altered);
  assert.equal(result.internallyConsistent, false);
  assert.ok(result.consistencyErrors.some((error) => error.includes("payment_settled")));
  assert.ok(result.consistencyErrors.some((error) => error.includes("recovery_receipt_verified")));
});

test("self-asserted RPC, signature, or on_chain_verified fields never count as chain proofs", () => {
  const altered = clonedArtifact();
  altered.events.find((e) => e.kind === "recovery_receipt_verified").details.on_chain_verified = true;
  altered.events.find((e) => e.kind === "recovery_receipt_verified").details.signature = "ab".repeat(64);
  altered.nearProofBundle = Object.fromEntries(REQUIRED_CHAIN_PROOF_PARTS.map((part) => [part, "caller-supplied"]));

  const result = inspectSandboxArtifact(altered);
  assert.equal(result.internallyConsistent, true);
  assert.deepEqual(result.missingProofParts, []);
  assert.equal(result.cryptographicallyVerified, false);
  assert.equal(result.proofVerifierImplemented, false);
});

test("current artifact is missing the transaction, receipt, causal-link, and finality evidence", () => {
  const result = inspectSandboxArtifact(sandboxArtifact);
  assert.deepEqual(result.missingProofParts, REQUIRED_CHAIN_PROOF_PARTS);
  assert.equal(result.cryptographicallyVerified, false);
});
