import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRecoveryReceiptEvent } from "./recovery-proof.js";
import { ReceiptReplayLedger } from "./receipt-replay.js";

export interface DemoEvent { id: number; at: string; kind: string; details: Record<string, unknown> }
export interface DemoSnapshot { status: "idle" | "running" | "succeeded" | "failed"; events: DemoEvent[]; error?: string; exitCode?: number; startedAt?: string; finishedAt?: string }
const required = ["sandbox_configured", "primary_heartbeat", "checkpoint_committed", "payment_settled", "primary_failed", "backup_restored", "duplicate_payment_prevented", "suspicious_payment_rejected", "guardian_warning", "guardian_quarantined", "recovery_receipt_verified", "demo_complete"];
export function demoCompletedSuccessfully(exitCode: number | null, events: DemoEvent[], replayedSignatures = new Set<string>()): boolean {
  const seen = new Set(events.map(event => event.kind));
  return exitCode === 0
    && required.every(kind => seen.has(kind))
    && verifyRecoveryReceiptEvent(events, replayedSignatures);
}
export async function demoCompletedSuccessfullyWithReplayLedger(
  exitCode: number | null,
  events: DemoEvent[],
  replayLedger: Pick<ReceiptReplayLedger, "claim">,
): Promise<boolean> {
  if (!demoCompletedSuccessfully(exitCode, events, new Set())) return false;
  const receiptEvents = events.filter(event => event.kind === "recovery_receipt_verified");
  const receiptDetails = receiptEvents.length === 1 ? receiptEvents[0]?.details : undefined;
  const signature = receiptDetails?.signature;
  if (typeof signature !== "string") return false;
  return replayLedger.claim(signature);
}
const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
type DemoLauncher = () => ChildProcessWithoutNullStreams;

export class DemoRunner {
  #child?: ChildProcessWithoutNullStreams;
  #snapshot: DemoSnapshot = { status: "idle", events: [] };
  #timer?: NodeJS.Timeout;
  #stopping = false;
  #finishing = false;
  constructor(
    private readonly launch: DemoLauncher = () => spawn("cargo", ["run", "--offline", "--locked", "--manifest-path", "integration-tests/Cargo.toml", "--example", "phase7"], {
    cwd: root, env: demoEnvironment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: true,
    }),
    private readonly replayLedger = new ReceiptReplayLedger(),
  ) {}
  snapshot(): DemoSnapshot { return structuredClone(this.#snapshot); }
  start(): DemoSnapshot {
    // Never launch a second process while the previous process is still being
    // reaped, even if shutdown already marked its result as interrupted.
    if (this.#child || this.#finishing || this.#snapshot.status === "running") return this.snapshot();
    this.#snapshot = { status: "running", events: [], startedAt: new Date().toISOString() };
    const child = this.launch();
    this.#child = child;
    const output = createInterface({ input: child.stdout });
    output.on("line", line => {
      const prefix = "PHOENIX_CONTROL_EVENT ";
      if (!line.startsWith(prefix)) return;
      try {
        const parsed = JSON.parse(line.slice(prefix.length)) as { kind?: unknown; details?: unknown };
        if (typeof parsed.kind !== "string" || !parsed.details || typeof parsed.details !== "object") return;
        const event = { id: this.#snapshot.events.length + 1, at: new Date().toISOString(), kind: parsed.kind, details: parsed.details as Record<string, unknown> };
        this.#snapshot.events = [...this.#snapshot.events, event].slice(-200);
      } catch { /* Ignore malformed child output; it cannot mark the demo successful. */ }
    });
    // Do not expose child stderr through the polling API; it may contain local
    // paths, environment details or test-only material.
    child.stderr.on("data", () => {});
    this.#timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.once("error", () => {
      this.#snapshot = { ...this.#snapshot, status: "failed", error: "Local recovery demo process could not start.", finishedAt: new Date().toISOString() };
      this.#clear(child);
    });
    child.once("close", (code, signal) => {
      this.#finishing = true;
      this.#clear(child);
      void this.#finish(code, signal, this.#stopping).finally(() => { this.#finishing = false; });
    });
    return this.snapshot();
  }
  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    const pid = child.pid;
    try {
      if (pid) process.kill(-pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch { child.kill("SIGTERM"); }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 3_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
    if (this.#child === child) {
      try { if (pid) process.kill(-pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { child.kill("SIGKILL"); }
      this.#snapshot = { ...this.#snapshot, status: "failed", error: "Backend stopped; the local demonstration was interrupted.", finishedAt: new Date().toISOString() };
      // Keep the child slot occupied until Node confirms exit. This prevents a
      // caller from starting a concurrent sandbox while SIGKILL is taking effect.
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 2_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      if (child.exitCode !== null || child.signalCode !== null) this.#clear(child);
    }
    this.#stopping = false;
  }
  #clear(child: ChildProcessWithoutNullStreams) {
    if (this.#child === child) this.#child = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  async #finish(code: number | null, signal: NodeJS.Signals | null, interrupted: boolean) {
    let complete = false;
    try {
      complete = await demoCompletedSuccessfullyWithReplayLedger(code, this.#snapshot.events, this.replayLedger);
    } catch {
      // Replay storage errors fail closed and are deliberately not returned to
      // the browser API, where they could expose local filesystem details.
    }
    this.#snapshot = {
      ...this.#snapshot,
      status: complete ? "succeeded" : "failed",
      exitCode: code ?? undefined,
      error: complete ? undefined : interrupted
        ? "Backend stopped; the local demonstration was interrupted."
        : `Sandbox demonstration incomplete or receipt verification failed (exit=${code ?? signal ?? "unknown"}).`,
      finishedAt: new Date().toISOString(),
    };
  }
}

function demoEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NEAR_NETWORK: "localnet" };
  for (const key of ["CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "CARGO_TARGET_DIR", "LD_LIBRARY_PATH"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}
