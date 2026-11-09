import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { guardianAuditHistoryVerified, heartbeatStatus, isLoopbackHttp, readAnchoredGuardianEvents, readControlState, type JsonObject } from "./control-plane.js";
import { DemoRunner } from "./demo.js";

test("local RPC accepts loopback only", () => {
  assert.equal(isLoopbackHttp("http://127.0.0.1:3030"), true);
  assert.equal(isLoopbackHttp("http://localhost:3030"), true);
  assert.equal(isLoopbackHttp("https://127.0.0.1:3030"), false);
  assert.equal(isLoopbackHttp("http://example.org:3030"), false);
});

test("heartbeat display derives live/expired from chain timestamps", () => {
  assert.equal(heartbeatStatus("Running", "1000000000", "3000000000", 2_000_000_000n), "live");
  assert.equal(heartbeatStatus("Running", "1000000000", "1000000000", 2_000_000_001n), "expired");
  assert.equal(heartbeatStatus("Contained", "1000000000", "3000000000", 2_000_000_000n), "unknown");
});

test("missing system configuration is shown as unavailable, never as success", async () => {
  const state = await readControlState({});
  assert.equal(state.configured, false);
  assert.equal(state.source, "unavailable");
  assert.match(state.error ?? "", /Set PHOENIX_CORE_ID/);
});

test("control state is assembled from finalized contract views", async () => {
  const agent = { status: "Running", generation: "2", heartbeat_at: (BigInt(Date.now()) * 1_000_000n - 1_000_000_000n).toString(), timeout_ns: "300000000000" };
  const flow = { task_id: "task.demo", worker_key: "bb", backup_keys: ["bb", "cc"], head: { digest: "a1", generation: "2", sequence: "4", expires_at: "1900000000000000000" } };
  const task = { funded: "100", available: "60", reserved: "10", pending: "5", paid: "25", refunded: "0", execution_epoch: "2", expires_at: "2000000000000000000", paused: false, sentinel: { last_nonce: 7 } };
  const values: Record<string, unknown> = {
    get_agent: agent, get_stateflow: flow, get_security_revision: "3", get_security_audit: null,
    get_sentinel_policy: { last_nonce: 8, domain: {} }, get_task: task,
    get_recovery_receipt: { task_id: "task.demo", primary_identity: "aa", backup_identity: "bb", checkpoint_hash: "a1", epoch_from: "1", epoch_to: "2", security_revision: "3", recovered_at: "10", verified_by: "sentinel.test", verified_at: "11", signed_receipt: null },
  };
  const calls: string[] = [];
  const reader = { async view(_account: string, method: string, _args: JsonObject) { calls.push(method); return { value: values[method], blockHeight: 99, blockHash: "same-final-block" }; }, async blockTimestamp() { return (BigInt(Date.now()) * 1_000_000n).toString(); } };
  const state = await readControlState({ PHOENIX_CORE_ID: "phoenix.test", REWIND_VAULT_ID: "rewind.test", PHOENIX_AGENT_ID: "agent.test", PHOENIX_TASK_ID: "task.demo", PHOENIX_OPERATION_IDS: "" }, reader);
  assert.equal(state.source, "near-rpc");
  assert.equal(state.chain?.blockHeight, 99);
  assert.equal(state.agent?.heartbeatStatus, "live");
  assert.equal(state.agent?.generation, "2");
  assert.equal(state.checkpoint, flow.head);
  assert.equal(state.proofOfRecovery?.status, "returned-by-finalized-contract-view");
  assert.equal((state.proofOfRecovery?.receipt as Record<string, unknown>).backup_identity, "bb");
  assert.equal(state.backupActivation?.backupActive, true);
  assert.equal(state.sentinel?.approvalsConsumed, 8);
  assert.equal(state.sentinel?.taskApprovalNonce, 7);
  assert.equal(state.escrow?.paid, "25");
  assert.deepEqual(calls, ["get_agent", "get_stateflow", "get_security_revision", "get_security_audit", "get_sentinel_policy", "get_task", "get_recovery_receipt"]);
});

test("telemetry errors fail to unavailable without inferred agent state", async () => {
  const reader = { async view(): Promise<{ value: unknown; blockHeight: number; blockHash: string }> { throw new Error("local RPC offline; RPC_TOKEN_MARKER"); }, async blockTimestamp(): Promise<string> { throw new Error("local RPC offline; RPC_TOKEN_MARKER"); } };
  const state = await readControlState({ PHOENIX_CORE_ID: "c", REWIND_VAULT_ID: "v", PHOENIX_AGENT_ID: "a", PHOENIX_TASK_ID: "t" }, reader);
  assert.equal(state.source, "unavailable");
  assert.equal(state.agent, undefined);
  assert.equal(state.error, "Local chain telemetry unavailable");
  assert.equal(state.error?.includes("RPC_TOKEN_MARKER"), false);
});

test("Guardian audit verification preserves large chain timestamps and checks anchored bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phoenix-audit-test-"));
  try {
    const seed = Buffer.alloc(32, 19);
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
    const publicHex = publicDer.subarray(-32).toString("hex");
    const domain = { network: "sandbox", deployment: "audit-test", core_id: "core.test", vault_id: "vault.test", agent_id: "agent.test", task_id: "task.test", execution_id: "exec", code_digest: "11".repeat(32), policy_digest: "22".repeat(32) };
    const body = `{"domain":${JSON.stringify(domain)},"sequence":1,"previous_digest":null,"event":{"body":{"domain":${JSON.stringify(domain)},"source_key":"${"33".repeat(32)}","source_nonce":1,"evidence_id":"${"44".repeat(32)}","epoch":0,"issued_at":1800000000000000001,"kind":{"TransferObserved":{"operation_id":"${"66".repeat(32)}","recipient":"recipient.test","amount":"25"}}},"signature":"${"55".repeat(64)}"},"decision":{"Quarantine":{"reason":"Suspicious settlement intent"}}}`;
    const signature = sign(null, Buffer.concat([Buffer.from("PHOENIX_GUARDIAN_AUDIT_V1\0"), Buffer.from(body)]), privateKey).toString("hex");
    const record = Buffer.from(`{"body":${body},"signature":"${signature}"}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "00000000000000000001.json"), record);
    const head = { sequence: "1", digest: createHash("sha256").update(record).digest("hex") };
    const events = await readAnchoredGuardianEvents(dir, head, publicHex, domain);
    assert.equal(guardianAuditHistoryVerified(events, head, dir, publicHex), true);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "TransferObserved");
    assert.equal(events[0]?.decision, "Quarantine");
    assert.equal(events[0]?.reason, "Suspicious settlement intent");
    assert.equal(events[0]?.epoch, 0);
    assert.equal(events[0]?.observedAtNs, "1800000000000000001");
    assert.equal(events[0]?.sourceKey, "33".repeat(32));
    assert.equal(events[0]?.evidenceId, "44".repeat(32));
    assert.deepEqual(events[0]?.details, { operation_id: "66".repeat(32), recipient: "recipient.test", amount: "25" });
    await writeFile(join(dir, "00000000000000000001.json"), Buffer.from(record.toString().replace("Suspicious settlement intent", "Forged event")));
    const forgedEvents = await readAnchoredGuardianEvents(dir, head, publicHex, domain);
    assert.deepEqual(forgedEvents, []);
    assert.equal(guardianAuditHistoryVerified(forgedEvents, head, dir, publicHex), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Guardian analytics provenance requires a complete matching anchored history", () => {
  const head = { sequence: "1", digest: "aa".repeat(32) };
  assert.equal(guardianAuditHistoryVerified([{ sequence: 1 }], head, tmpdir(), "bb".repeat(32)), true);
  assert.equal(guardianAuditHistoryVerified([], head, tmpdir(), "bb".repeat(32)), false);
  assert.equal(guardianAuditHistoryVerified([{ sequence: 1 }], head, undefined, "bb".repeat(32)), false);
  assert.equal(guardianAuditHistoryVerified([{ sequence: 1 }], head, tmpdir(), undefined), false);
  assert.equal(guardianAuditHistoryVerified([], { sequence: "0", digest: "00".repeat(32) }, "/path/that/does/not/exist", "bb".repeat(32)), false);
});

test("backend restart stops the active demo process and does not preserve a false success", async () => {
  let childPid: number | undefined;
  const launcher = () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    childPid = child.pid;
    return child;
  };
  const beforeRestart = new DemoRunner(launcher);
  assert.equal(beforeRestart.start().status, "running");
  await beforeRestart.stop();
  assert.equal(beforeRestart.snapshot().status, "failed");
  assert.match(beforeRestart.snapshot().error ?? "", /Backend stopped/);
  assert.ok(childPid);
  assert.throws(() => process.kill(childPid!, 0), { code: "ESRCH" });
  const afterRestart = new DemoRunner(launcher);
  assert.equal(afterRestart.snapshot().status, "idle");
});
