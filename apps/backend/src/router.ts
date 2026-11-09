import type { DemoRunner, DemoSnapshot } from "./demo.js";
import type { ControlState } from "./control-plane.js";
import type { ContractStateInput, DeploymentPreflightInput, OperatorActionInput } from "./network.js";

export const TRUSTED_DASHBOARD_ORIGIN = "http://localhost:3000";
export interface ApiRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body?: string;
}
export interface ApiResponse { status: number; headers: Record<string, string>; body?: string }
export interface ApiDependencies {
  runner: Pick<DemoRunner, "snapshot" | "start">;
  demoStartLimiter?: DemoStartRateLimiter;
  controlState: () => Promise<ControlState>;
  network: {
    readiness?(): unknown;
    prepareOperatorAction?(input: OperatorActionInput): Promise<unknown>;
    health(): Promise<unknown>;
    account(accountId: string): Promise<unknown>;
    contractState(input: ContractStateInput): Promise<unknown>;
    transaction(hash: string, sender: string): Promise<unknown>;
    deploymentPreflight(input: DeploymentPreflightInput): Promise<unknown>;
  };
}

/** Shared per-backend cooldown for the resource-intensive local sandbox demo. */
export class DemoStartRateLimiter {
  #nextAllowedAt = 0;
  constructor(private readonly cooldownMs = 30_000, private readonly now: () => number = Date.now) {}
  retryAfterSeconds(): number {
    const current = this.now();
    const remaining = this.#nextAllowedAt - current;
    if (remaining > 0) return Math.ceil(remaining / 1_000);
    this.#nextAllowedAt = current + this.cooldownMs;
    return 0;
  }
}
const defaultDemoStartLimiter = new DemoStartRateLimiter();

function json(status: number, value: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers }, body: JSON.stringify(value) };
}

export async function handleApiRequest(request: ApiRequest, dependencies: ApiDependencies): Promise<ApiResponse> {
  const parsedUrl = new URL(request.url, "http://127.0.0.1");
  const pathname = parsedUrl.pathname;
  const origin = request.headers.origin;
  const allowedOrigin = origin === TRUSTED_DASHBOARD_ORIGIN;
  const cors: Record<string, string> = allowedOrigin ? { "Access-Control-Allow-Origin": TRUSTED_DASHBOARD_ORIGIN, Vary: "Origin" } : {};
  if (origin && !allowedOrigin) return json(403, { error: "Dashboard origin rejected" });

  if (request.method === "OPTIONS") {
    if (!allowedOrigin) return json(403, { error: "Trusted dashboard origin required" });
    const method = request.headers["access-control-request-method"]?.toUpperCase();
    const networkPost = ["/api/network/deployment-preflight", "/api/network/prepare-action"].includes(pathname);
    const networkGet = pathname.startsWith("/api/network/");
    const allowedMethods = pathname === "/api/demo" || networkPost ? ["GET", "POST"] : ["/api/control-plane", "/health"].includes(pathname) || networkGet ? ["GET"] : [];
    if (!method || !allowedMethods.includes(method)) return json(403, { error: "Preflight method rejected" }, cors);
    const requestedHeaders = (request.headers["access-control-request-headers"] ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some(header => header !== "content-type") || (requestedHeaders.length > 0 && method !== "POST")) return json(403, { error: "Preflight header rejected" }, cors);
    return { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": `${allowedMethods.join(", ")}, OPTIONS`, ...(method === "POST" ? { "Access-Control-Allow-Headers": "Content-Type" } : {}), "Access-Control-Max-Age": "600", "Cache-Control": "no-store", "Vary": "Origin" } };
  }

  if (request.method === "POST" && !allowedOrigin) return json(403, { error: "Trusted dashboard origin required for local actions" });
  if (request.method === "GET" && pathname === "/health") return json(200, { version: "5.0.0", status: "ready", chainAccess: "read-only", executionEnabled: false }, cors);
  if (request.method === "GET" && pathname === "/api/control-plane") {
    try { return json(200, await dependencies.controlState(), cors); }
    catch { return json(503, { error: "Control Plane telemetry unavailable" }, cors); }
  }
  if (request.method === "GET" && pathname === "/api/network/health") {
    try { return json(200, await dependencies.network.health(), cors); }
    catch { return json(503, { error: "NEAR network unavailable" }, cors); }
  }
  if (request.method === "GET" && pathname === "/api/network/account") {
    const accountId = parsedUrl.searchParams.get("accountId");
    if (!accountId) return json(400, { error: "accountId is required" }, cors);
    try { return json(200, await dependencies.network.account(accountId), cors); }
    catch (error) { const invalid = error instanceof Error && error.message.startsWith("Invalid"); return json(invalid ? 400 : 503, { error: invalid ? "Invalid account ID" : "Account lookup failed" }, cors); }
  }
  if (request.method === "GET" && pathname === "/api/network/contract-state") {
    const params = parsedUrl.searchParams;
    const values = { coreId: params.get("coreId") ?? "", vaultId: params.get("vaultId") ?? "", agentId: params.get("agentId") ?? "", taskId: params.get("taskId") ?? "" };
    try { return json(200, await dependencies.network.contractState(values), cors); }
    catch (error) { const invalid = error instanceof Error && error.message.startsWith("Invalid"); return json(invalid ? 400 : 503, { error: invalid ? "Invalid contract, agent or task account ID" : "Contract state lookup failed" }, cors); }
  }
  if (request.method === "GET" && pathname === "/api/network/transaction") {
    const params = parsedUrl.searchParams;
    const hash = params.get("hash") ?? ""; const sender = params.get("sender") ?? "";
    try { return json(200, await dependencies.network.transaction(hash, sender), cors); }
    catch (error) { const invalid = error instanceof Error && error.message.startsWith("Invalid"); return json(invalid ? 400 : 503, { error: invalid ? "Invalid transaction hash or sender account ID" : "Transaction lookup failed" }, cors); }
  }
  if (request.method === "GET" && pathname === "/api/network/readiness") {
    try { return json(200, dependencies.network.readiness?.() ?? {enabled: false, blockers: ["Operator actions unavailable"]}, cors); }
    catch { return json(503, {error: "Readiness unavailable"}, cors); }
  }
  if (request.method === "POST" && pathname === "/api/network/prepare-action") {
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") return json(415, {error: "application/json required"}, cors);
    if (Buffer.byteLength(request.body ?? "") > 1024) return json(413, {error: "Request too large"}, cors);
    let body: unknown;
    try { body = JSON.parse(request.body ?? ""); } catch { return json(400, {error: "Invalid JSON body"}, cors); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["accountId", "agentId", "action"].includes(k))) return json(400, {error: "Only public identifiers and an allowed operator action are accepted"}, cors);
    if (!dependencies.network.prepareOperatorAction) return json(503, {error: "Operator actions unavailable"}, cors);
    try { return json(200, await dependencies.network.prepareOperatorAction(body as OperatorActionInput), cors); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      const safeValidation = message.startsWith("Invalid") || message.includes("requires explicit") || message.includes("requires the registered") || message.includes("requires an expired");
      return json(safeValidation ? 400 : 503, {error: safeValidation ? message : "Action preparation unavailable"}, cors);
    }
  }
  if (request.method === "POST" && pathname === "/api/network/deployment-preflight") {
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") return json(415, { error: "application/json required" }, cors);
    if (Buffer.byteLength(request.body ?? "") > 1024) return json(413, {error: "Request too large"}, cors);
    let body: unknown;
    try { body = JSON.parse(request.body ?? ""); } catch { return json(400, { error: "Invalid JSON body" }, cors); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "Deployment preflight arguments required" }, cors);
    const allowedFields = new Set(["accountId", "publicKey", "coreContractId", "vaultContractId", "expectedCoreCodeHash", "expectedVaultCodeHash"]);
    if (Object.keys(body).some(key => !allowedFields.has(key))) return json(400, { error: "Preflight accepts public identifiers and hashes only; secret or unknown fields are forbidden" }, cors);
    try { return json(200, await dependencies.network.deploymentPreflight(body as DeploymentPreflightInput), cors); }
    catch (error) { const message = error instanceof Error ? error.message : ""; const safeValidation = message.startsWith("Invalid") || message.includes("requires explicit"); return json(safeValidation ? 400 : 503, { error: safeValidation ? message : "Deployment preflight unavailable" }, cors); }
  }
  if (request.method === "GET" && pathname === "/api/demo") return json(200, dependencies.runner.snapshot(), cors);
  if (request.method === "POST" && pathname === "/api/demo") {
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") return json(415, { error: "application/json required" }, cors);
    if (Buffer.byteLength(request.body ?? "") > 1024) return json(413, {error: "Request too large"}, cors);
    let body: unknown;
    try { body = JSON.parse(request.body ?? ""); } catch { return json(400, { error: "Invalid JSON body" }, cors); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || (body as { action?: unknown }).action !== "start") return json(400, { error: "Expected only action=start" }, cors);
    try {
      if (dependencies.runner.snapshot().status !== "running") {
        const retryAfter = (dependencies.demoStartLimiter ?? defaultDemoStartLimiter).retryAfterSeconds();
        if (retryAfter > 0) return json(429, {error: "Local recovery demo is rate limited", retryAfterSeconds: retryAfter}, { ...cors, "Retry-After": String(retryAfter) });
      }
      const state: DemoSnapshot = dependencies.runner.start();
      return json(202, state, cors);
    } catch {
      return json(503, { error: "Local demo could not start" }, cors);
    }
  }
  if (request.method !== "GET" && request.method !== "POST") return json(405, { error: "Method not allowed" }, cors);
  return json(404, { error: "Not found" }, cors);
}
