import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { statSync } from "node:fs";

export type JsonObject = Record<string, unknown>;
export interface ControlState {
  source: "near-rpc" | "unavailable";
  configured: boolean;
  observedAt: string;
  chain?: { blockHeight: number; blockTimestampNs: string };
  agent?: JsonObject | null;
  checkpoint?: JsonObject | null;
  proofOfRecovery?: JsonObject | null;
  backupActivation?: JsonObject | null;
  sentinel?: JsonObject | null;
  guardian?: JsonObject | null;
  escrow?: JsonObject | null;
  error?: string;
}
export interface RpcReader {
  view(accountId: string, method: string, args: JsonObject, blockHash?: string): Promise<{ value: unknown; blockHeight: number; blockHash: string }>;
  blockTimestamp(blockHash: string): Promise<string>;
}

export function isLoopbackHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

export function heartbeatStatus(status: unknown, heartbeatAt: unknown, timeout: unknown, nowNs = BigInt(Date.now()) * 1_000_000n): "live" | "expired" | "unknown" {
  if (status !== "Running" || typeof heartbeatAt !== "string" || typeof timeout !== "string") return "unknown";
  try {
    const heartbeat = BigInt(heartbeatAt); const limit = BigInt(timeout);
    return nowNs >= heartbeat && nowNs - heartbeat < limit ? "live" : "expired";
  } catch { return "unknown"; }
}

export class NearLocalReader implements RpcReader {
  readonly rpcUrl: string;
  constructor(rpcUrl = process.env.NEAR_RPC_URL ?? "http://127.0.0.1:3030") {
    if (!isLoopbackHttp(rpcUrl)) throw new Error("NEAR_RPC_URL must use HTTP on loopback; remote networks are disabled");
    this.rpcUrl = rpcUrl;
  }
  async view(accountId: string, method: string, args: JsonObject, blockHash?: string): Promise<{ value: unknown; blockHeight: number; blockHash: string }> {
    const response = await fetch(this.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      jsonrpc: "2.0", id: "phoenix-control-plane", method: "query",
      params: { request_type: "call_function", account_id: accountId, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), ...(blockHash ? { block_id: blockHash } : { finality: "final" }) },
    }), signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error(`Local NEAR RPC returned HTTP ${response.status}`);
    const envelope = await response.json() as { result?: { result?: number[]; block_height?: number; block_hash?: string }; error?: { message?: string } };
    if (envelope.error) throw new Error(envelope.error.message ?? "Local NEAR RPC query failed");
    if (!envelope.result?.result || typeof envelope.result.block_height !== "number" || typeof envelope.result.block_hash !== "string") throw new Error("Malformed local NEAR RPC response");
    const bytes = Uint8Array.from(envelope.result.result);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: text ? JSON.parse(text) as unknown : null, blockHeight: envelope.result.block_height, blockHash: envelope.result.block_hash };
  }
  async blockTimestamp(blockHash: string): Promise<string> {
    const response = await fetch(this.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "phoenix-control-plane-block", method: "block", params: { block_id: blockHash } }), signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error(`Local NEAR RPC returned HTTP ${response.status}`);
    const envelope = await response.json() as { result?: { header?: { timestamp_nanosec?: string } }; error?: { message?: string } };
    if (envelope.error) throw new Error(envelope.error.message ?? "Local finalized block query failed");
    const timestamp = envelope.result?.header?.timestamp_nanosec;
    if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp)) throw new Error("Malformed local finalized block timestamp");
    return timestamp;
  }
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function rawObjectField(source: string, wanted: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"') {
      const begin = i; let escaped = false; i++;
      for (; i < source.length; i++) {
        const current = source[i]!;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
      }
      if (depth === 1 && JSON.parse(source.slice(begin, i + 1)) === wanted) {
        let valueStart = i + 1;
        while (/\s/.test(source[valueStart] ?? "")) valueStart++;
        if (source[valueStart] !== ":") continue;
        valueStart++;
        while (/\s/.test(source[valueStart] ?? "")) valueStart++;
        if (source[valueStart] !== "{") return undefined;
        let nested = 0; let inString = false; let slash = false;
        for (let j = valueStart; j < source.length; j++) {
          const item = source[j]!;
          if (inString) {
            if (slash) slash = false;
            else if (item === "\\") slash = true;
            else if (item === '"') inString = false;
          } else if (item === '"') inString = true;
          else if (item === "{") nested++;
          else if (item === "}" && --nested === 0) return source.slice(valueStart, j + 1);
        }
        return undefined;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return undefined;
}

export async function readAnchoredGuardianEvents(directory: string | undefined, head: JsonObject | null, publicKeyHex: string | undefined, domain: JsonObject): Promise<JsonObject[]> {
  if (!directory || !head || typeof head.sequence !== "string" || typeof head.digest !== "string") return [];
  if (!publicKeyHex || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return [];
  try {
    const files = (await readdir(directory)).filter(name => /^\d{20}\.json$/.test(name)).sort();
    const anchored = Number(head.sequence);
    const result: JsonObject[] = [];
    let previousDigest: string | null = null;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    for (const name of files) {
      const sequence = Number(name.slice(0, 20));
      if (!Number.isSafeInteger(sequence) || sequence > anchored) continue;
      if (sequence !== result.length + 1) return [];
      const raw = await readFile(join(directory, name));
      const rawText = raw.toString("utf8");
      const record = object(JSON.parse(rawText));
      const body = object(record.body);
      const event = object(body.event); const eventBody = object(event.body);
      if (body.sequence !== sequence || JSON.stringify(body.domain) !== JSON.stringify(domain) || (body.previous_digest ?? null) !== previousDigest) return [];
      if (typeof record.signature !== "string" || !/^[0-9a-f]{128}$/.test(record.signature)) return [];
      const bodyJson = rawObjectField(rawText, "body");
      if (!bodyJson) return [];
      const eventJson = rawObjectField(bodyJson, "event");
      const eventBodyJson = eventJson && rawObjectField(eventJson, "body");
      const issuedAt = eventBodyJson && /"issued_at"\s*:\s*(\d+)/.exec(eventBodyJson)?.[1];
      if (!issuedAt) return [];
      const message = Buffer.concat([Buffer.from("PHOENIX_GUARDIAN_AUDIT_V1\0"), Buffer.from(bodyJson)]);
      if (!verifySignature(null, message, key, Buffer.from(record.signature, "hex"))) return [];
      const digest = createHash("sha256").update(raw).digest("hex");
      if (sequence === anchored && digest !== head.digest) return [];
      previousDigest = digest;
      const taggedKind = eventBody.kind;
      const kindName = typeof taggedKind === "string" ? taggedKind : Object.keys(object(taggedKind))[0] ?? "Unknown";
      const rawDetails = typeof taggedKind === "object" && taggedKind !== null && !Array.isArray(taggedKind)
        ? object(object(taggedKind)[kindName]) : {};
      const allowedDetailFields = ["approval_id", "reason", "operation_id", "recipient", "amount", "replayed_evidence_id", "target", "worker_key", "worker_epoch", "evidence_digest", "observed_epoch", "score", "actions"];
      const details: JsonObject = {};
      for (const field of allowedDetailFields) {
        const value = rawDetails[field];
        if (typeof value === "string") details[field] = value.slice(0, 128);
        else if (typeof value === "number" || typeof value === "boolean") details[field] = value;
      }
      const decisionValue = object(body.decision);
      const decisionName = typeof body.decision === "string" ? body.decision : Object.keys(decisionValue)[0] ?? "Unknown";
      const decisionDetails = object(decisionValue[decisionName]);
      result.push({
        sequence, kind: kindName, details, decision: decisionName,
        reason: typeof decisionDetails.reason === "string" ? decisionDetails.reason.slice(0, 160) : undefined,
        observedAtNs: issuedAt, epoch: eventBody.epoch,
        sourceKey: typeof eventBody.source_key === "string" ? eventBody.source_key : undefined,
        evidenceId: typeof eventBody.evidence_id === "string" ? eventBody.evidence_id : undefined,
        digest,
      });
    }
    // Never present records newer than the on-chain chain of custody.
    return result.length === anchored ? result : [];
  } catch { return []; }
}

export function guardianAuditHistoryVerified(events: JsonObject[], head: JsonObject | null, directory: string | undefined, publicKeyHex: string | undefined): boolean {
  if (!directory || !head || typeof head.sequence !== "string" || !/^\d+$/.test(head.sequence)
    || !Number.isSafeInteger(Number(head.sequence)) || typeof head.digest !== "string"
    || !/^[0-9a-f]{64}$/.test(head.digest) || !publicKeyHex || !/^[0-9a-f]{64}$/.test(publicKeyHex)) return false;
  try { if (!statSync(directory).isDirectory()) return false; } catch { return false; }
  // readAnchoredGuardianEvents returns rows only after signatures, sequence,
  // linkage and the configured on-chain head digest have all been checked.
  return events.length === Number(head.sequence);
}

export async function readControlState(env: NodeJS.ProcessEnv = process.env, reader?: RpcReader): Promise<ControlState> {
  const observedAt = new Date().toISOString();
  const coreId = env.PHOENIX_CORE_ID; const vaultId = env.REWIND_VAULT_ID;
  const agentId = env.PHOENIX_AGENT_ID; const taskId = env.PHOENIX_TASK_ID;
  if (env.NEAR_NETWORK && env.NEAR_NETWORK !== "localnet") return { source: "unavailable", configured: false, observedAt, error: "Control Plane telemetry is localnet-only" };
  if (!coreId || !vaultId || !agentId || !taskId) return { source: "unavailable", configured: false, observedAt, error: "Set PHOENIX_CORE_ID, REWIND_VAULT_ID, PHOENIX_AGENT_ID and PHOENIX_TASK_ID" };
  const rpc = reader ?? new NearLocalReader();
  try {
    const coreAccount = await rpc.view(coreId, "get_agent", { agent_id: agentId });
    const blockHash = coreAccount.blockHash;
    const blockTimestampNs = await rpc.blockTimestamp(blockHash);
    const flow = await rpc.view(coreId, "get_stateflow", { agent_id: agentId }, blockHash);
    const revision = await rpc.view(coreId, "get_security_revision", { agent_id: agentId }, blockHash);
    const audit = await rpc.view(coreId, "get_security_audit", { agent_id: agentId }, blockHash);
    const corePolicy = await rpc.view(coreId, "get_sentinel_policy", { agent_id: agentId }, blockHash);
    const taskResult = await rpc.view(vaultId, "get_task", { task_id: taskId }, blockHash);
    const agent = coreAccount.value === null ? null : object(coreAccount.value);
    const flowValue = flow.value === null ? null : object(flow.value);
    const task = taskResult.value === null ? null : object(taskResult.value);
    if (!agent || !flowValue || !task) throw new Error("Configured agent, STATEFLOW or REWIND task was not found");
    const head = flowValue.head === null ? null : object(flowValue.head);
    const auditHead = audit.value === null ? null : object(audit.value);
    const sentinelPolicy = corePolicy.value === null ? null : object(corePolicy.value);
    const backupKeys = Array.isArray(flowValue.backup_keys) ? flowValue.backup_keys : [];
    const generation = text(agent.generation);
    if (!generation || !/^\d+$/.test(generation)) throw new Error("Malformed on-chain recovery generation");
    const receiptResult = await rpc.view(coreId, "get_recovery_receipt", { agent_id: agentId, epoch_to: generation }, blockHash);
    const recoveryProof = receiptResult.value === null ? null : object(receiptResult.value);
    const operationIds = (env.PHOENIX_OPERATION_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 64);
    const ops: JsonObject[] = [];
    for (const operationId of operationIds) {
      const op = await rpc.view(vaultId, "get_operation", { operation_id: operationId }, blockHash);
      if (op.value !== null) ops.push({ operationId, ...object(op.value) });
    }
    const auditDomain = object(sentinelPolicy?.domain);
    const guardianEvents = await readAnchoredGuardianEvents(env.PHOENIX_GUARDIAN_AUDIT_DIR, auditHead, env.PHOENIX_GUARDIAN_AUDIT_PUBLIC_KEY, auditDomain);
    const guardianHistoryVerified = guardianAuditHistoryVerified(guardianEvents, auditHead,
      env.PHOENIX_GUARDIAN_AUDIT_DIR, env.PHOENIX_GUARDIAN_AUDIT_PUBLIC_KEY);
    const height = Math.min(coreAccount.blockHeight, flow.blockHeight, revision.blockHeight, audit.blockHeight, corePolicy.blockHeight, taskResult.blockHeight, receiptResult.blockHeight);
    return {
      source: "near-rpc", configured: true, observedAt, chain: { blockHeight: height, blockTimestampNs },
      agent: { id: agentId, status: agent.status, generation: agent.generation, heartbeatAt: agent.heartbeat_at,
        timeoutNs: agent.timeout_ns, heartbeatStatus: heartbeatStatus(agent.status, text(agent.heartbeat_at), text(agent.timeout_ns), BigInt(blockTimestampNs)),
        securityRevision: revision.value },
      checkpoint: head,
      proofOfRecovery: { currentEpoch: generation, receipt: recoveryProof,
        status: receiptResult.value === null ? "no-receipt-at-current-epoch" : "returned-by-finalized-contract-view" },
      backupActivation: { currentWorker: flowValue.worker_key, registeredBackups: backupKeys,
        backupActive: recoveryProof !== null && recoveryProof.backup_identity === flowValue.worker_key && text(recoveryProof.epoch_to) === generation,
        taskId: flowValue.task_id },
      sentinel: { configured: sentinelPolicy !== null, approvalsConsumed: object(sentinelPolicy).last_nonce ?? "0",
        taskPolicyConfigured: task.sentinel !== null, taskApprovalNonce: object(task.sentinel).last_nonce ?? "0" },
      guardian: { quarantine: agent.status === "Contained" || task.paused === true, taskPaused: task.paused,
        auditHead, auditVerified: guardianHistoryVerified, events: guardianEvents },
      escrow: { taskId, funded: task.funded, available: task.available, reserved: task.reserved,
        pending: task.pending, paid: task.paid, refunded: task.refunded, executionEpoch: task.execution_epoch,
        expiresAt: task.expires_at, payments: ops },
    };
  } catch {
    // Internal RPC and filesystem failures can include URLs and local paths;
    // keep those details out of the dashboard response.
    return { source: "unavailable", configured: true, observedAt, error: "Local chain telemetry unavailable" };
  }
}

export async function guardianAuditSize(directory: string | undefined): Promise<number> {
  if (!directory) return 0;
  try { return (await stat(directory)).isDirectory() ? (await readdir(directory)).filter(f => f.endsWith(".json")).length : 0; }
  catch { return 0; }
}
