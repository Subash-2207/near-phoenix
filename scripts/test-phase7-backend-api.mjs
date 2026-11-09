#!/usr/bin/env node
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DemoRunner } from "../apps/backend/dist/demo.js";
import { handleApiRequest } from "../apps/backend/dist/router.js";
import { verifyRecoveryReceiptEvent } from "../apps/backend/dist/recovery-proof.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const runner = new DemoRunner();
const dependencies = {
  runner,
  controlState: async () => ({ configured: false, source: "unavailable" }),
  network: {
    health: async () => ({}),
    account: async () => ({}),
    contractState: async () => ({}),
    transaction: async () => ({}),
    deploymentPreflight: async () => ({}),
  },
};

const start = await handleApiRequest({
  method: "POST",
  url: "/api/demo",
  headers: { origin: "http://localhost:3000", "content-type": "application/json" },
  body: JSON.stringify({ action: "start" }),
}, dependencies);
assert.equal(start.status, 202, "POST /api/demo should start the local run");
const initial = JSON.parse(start.body ?? "{}");
assert.equal(initial.status, "running");

let finalResponse;
let snapshot;
const deadline = Date.now() + 120_000;
try {
  while (Date.now() < deadline) {
    finalResponse = await handleApiRequest({ method: "GET", url: "/api/demo", headers: {} }, dependencies);
    assert.equal(finalResponse.status, 200, "GET /api/demo should return the runner snapshot");
    snapshot = JSON.parse(finalResponse.body ?? "{}");
    if (snapshot.status === "succeeded" || snapshot.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(snapshot?.status, "succeeded", snapshot?.error ?? "Local Phase 7 run did not complete");
  assert.equal(snapshot?.exitCode, 0);
  assert.equal(verifyRecoveryReceiptEvent(snapshot.events, new Set()), true, "Receipt must verify against the emitted sandbox evidence");

  const artifact = {
    api: { postStatus: start.status, postInitialStatus: initial.status, getStatus: finalResponse?.status },
    ...snapshot,
  };
  const evidenceOutput = process.env.PHOENIX_DEMO_EVIDENCE_OUTPUT
    ? resolve(process.env.PHOENIX_DEMO_EVIDENCE_OUTPUT)
    : join(root, "docs/PHASE7B-E2E-EVIDENCE.json");
  await writeFile(
    evidenceOutput,
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  const receipt = snapshot.events.find(event => event.kind === "recovery_receipt_verified");
  console.log(JSON.stringify({
    postStatus: start.status,
    initialStatus: initial.status,
    getStatus: finalResponse?.status,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    eventCount: snapshot.events.length,
    evidenceOutput,
    receiptSignature: receipt?.details.signature,
    settlementReference: receipt?.details.body?.settlement_reference,
  }));
} finally {
  if (runner.snapshot().status === "running") await runner.stop();
}
