import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoStartRateLimiter, handleApiRequest, TRUSTED_DASHBOARD_ORIGIN, type ApiDependencies, type ApiRequest } from "./router.js";

const state = { source: "near-rpc" as const, configured: true, observedAt: "2026-11-04T00:00:00.000Z", chain: { blockHeight: 42, blockTimestampNs: "1800000000000000000" } };
function fixture() {
  let starts = 0; let polls = 0;
  const dependencies: ApiDependencies = {
    runner: { snapshot: () => { polls++; return { status: "running", events: [] }; }, start: () => { starts++; return { status: "running", events: [] }; } },
    controlState: async () => state,
    network: {
      health: async () => ({ network: "mainnet", connected: true }),
      account: async accountId => ({ accountId, network: "mainnet" }),
      contractState: async value => ({ ...value, verification: "finalized-rpc-observation" }),
      transaction: async (hash, sender) => ({ hash, sender, explorerUrl: null }),
      deploymentPreflight: async value => ({ ...value, transactionsBroadcast: false }),
    },
  };
  return { dependencies, starts: () => starts, polls: () => polls };
}
const request = (method: string, url: string, headers: Record<string, string | undefined> = {}, body?: string): ApiRequest => ({ method, url, headers, body });

test("operator preparation requires the trusted origin and rejects secrets, oversized bodies and unsupported input", async () => {
  const f = fixture(); let prepared = 0;
  f.dependencies.network.prepareOperatorAction = async value => { prepared++; return {...value, serverBroadcasts: false}; };
  const headers = {origin: TRUSTED_DASHBOARD_ORIGIN, "content-type": "application/json"};
  const body = JSON.stringify({accountId: "operator.testnet", agentId: "agent.testnet", action: "heartbeat"});
  assert.equal((await handleApiRequest(request("POST", "/api/network/prepare-action", {"content-type": "application/json"}, body), f.dependencies)).status, 403);
  assert.equal((await handleApiRequest(request("POST", "/api/network/prepare-action", headers, JSON.stringify({privateKey: "not-a-key"})), f.dependencies)).status, 400);
  assert.equal((await handleApiRequest(request("POST", "/api/network/prepare-action", headers, "x".repeat(1025)), f.dependencies)).status, 413);
  assert.equal(prepared, 0);
  const result = await handleApiRequest(request("POST", "/api/network/prepare-action", headers, body), f.dependencies);
  assert.equal(result.status, 200); assert.equal(prepared, 1);
  assert.equal(JSON.parse(result.body!).serverBroadcasts, false);
});

test("trusted dashboard origin receives explicit CORS headers on polling", async () => {
  const f = fixture();
  const response = await handleApiRequest(request("GET", "/api/control-plane", { origin: TRUSTED_DASHBOARD_ORIGIN }), f.dependencies);
  assert.equal(response.status, 200);
  assert.equal(response.headers["Access-Control-Allow-Origin"], "http://localhost:3000");
  assert.equal(response.headers["Access-Control-Allow-Origin"].includes("*"), false);
  assert.deepEqual(JSON.parse(response.body ?? "{}"), state);
  const demo = await handleApiRequest(request("GET", "/api/demo", { origin: TRUSTED_DASHBOARD_ORIGIN }), f.dependencies);
  assert.equal(demo.status, 200);
  assert.equal(f.polls(), 1);
});

test("trusted origin receives CORS headers on backend error responses too", async () => {
  const f = fixture();
  const response = await handleApiRequest(request("GET", "/api/control-plane", { origin: TRUSTED_DASHBOARD_ORIGIN }), {
    ...f.dependencies, controlState: async () => { throw new Error("local RPC unavailable"); },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers["Access-Control-Allow-Origin"], TRUSTED_DASHBOARD_ORIGIN);
  assert.equal(JSON.parse(response.body ?? "{}").error, "Control Plane telemetry unavailable");
  assert.equal(JSON.parse(response.body ?? "{}").error.includes("local RPC unavailable"), false);
});

test("alternate localhost and untrusted origins are rejected without CORS permission", async () => {
  const f = fixture();
  for (const origin of ["http://127.0.0.1:3000", "http://localhost.evil.test:3000", "https://localhost:3000"]) {
    const response = await handleApiRequest(request("GET", "/api/control-plane", { origin }), f.dependencies);
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
  }
});

test("trusted CORS preflight permits only expected methods and content type", async () => {
  const f = fixture();
  const allowed = await handleApiRequest(request("OPTIONS", "/api/demo", {
    origin: TRUSTED_DASHBOARD_ORIGIN,
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  }), f.dependencies);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], TRUSTED_DASHBOARD_ORIGIN);
  assert.equal(allowed.headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
  assert.equal(allowed.headers["Access-Control-Allow-Headers"], "Content-Type");
  assert.equal(allowed.headers["Access-Control-Allow-Credentials"], undefined);

  const foreign = await handleApiRequest(request("OPTIONS", "/api/demo", { origin: "http://127.0.0.1:3000", "access-control-request-method": "POST" }), f.dependencies);
  assert.equal(foreign.status, 403);
  const badHeader = await handleApiRequest(request("OPTIONS", "/api/demo", { origin: TRUSTED_DASHBOARD_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" }), f.dependencies);
  assert.equal(badHeader.status, 403);
  const badMethod = await handleApiRequest(request("OPTIONS", "/api/demo", { origin: TRUSTED_DASHBOARD_ORIGIN, "access-control-request-method": "DELETE" }), f.dependencies);
  assert.equal(badMethod.status, 403);
  const readOnlyPost = await handleApiRequest(request("OPTIONS", "/api/control-plane", { origin: TRUSTED_DASHBOARD_ORIGIN, "access-control-request-method": "POST" }), f.dependencies);
  assert.equal(readOnlyPost.status, 403);
  const mainnetPreflight = await handleApiRequest(request("OPTIONS", "/api/network/deployment-preflight", { origin: TRUSTED_DASHBOARD_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }), f.dependencies);
  assert.equal(mainnetPreflight.status, 204);
});

test("network routes are read-only, query parameters survive routing, and mutations require trusted origin", async () => {
  const f = fixture();
  assert.equal((await handleApiRequest(request("GET", "/api/network/health", { origin: TRUSTED_DASHBOARD_ORIGIN }), f.dependencies)).status, 200);
  const account = await handleApiRequest(request("GET", "/api/network/account?accountId=alice.near", { origin: TRUSTED_DASHBOARD_ORIGIN }), f.dependencies);
  assert.equal(account.status, 200);
  assert.equal(JSON.parse(account.body ?? "{}").accountId, "alice.near");
  const untrusted = await handleApiRequest(request("POST", "/api/network/deployment-preflight", { origin: "https://evil.example", "content-type": "application/json" }, "{}"), f.dependencies);
  assert.equal(untrusted.status, 403);
  const missingOrigin = await handleApiRequest(request("POST", "/api/network/deployment-preflight", { "content-type": "application/json" }, "{}"), f.dependencies);
  assert.equal(missingOrigin.status, 403);
  const secretField = await handleApiRequest(request("POST", "/api/network/deployment-preflight", { origin: TRUSTED_DASHBOARD_ORIGIN, "content-type": "application/json" }, JSON.stringify({ publicKey: "ed25519:public", privateKey: "never-accept", seedPhrase: "never-accept" })), f.dependencies);
  assert.equal(secretField.status, 400);
  const noWrites = await handleApiRequest(request("POST", "/api/network/transaction", { origin: TRUSTED_DASHBOARD_ORIGIN, "content-type": "application/json" }, "{}"), f.dependencies);
  assert.equal(noWrites.status, 404);
});

test("demo start requires trusted Origin and JSON; trusted dashboard can start it", async () => {
  const f = fixture();
  const untrusted = await handleApiRequest(request("POST", "/api/demo", { origin: "http://127.0.0.1:3000", "content-type": "application/json" }, '{"action":"start"}'), f.dependencies);
  assert.equal(untrusted.status, 403);
  const missingOrigin = await handleApiRequest(request("POST", "/api/demo", { "content-type": "application/json" }, '{"action":"start"}'), f.dependencies);
  assert.equal(missingOrigin.status, 403);
  assert.equal(f.starts(), 0);

  const wrongType = await handleApiRequest(request("POST", "/api/demo", { origin: TRUSTED_DASHBOARD_ORIGIN, "content-type": "text/plain" }, '{"action":"start"}'), f.dependencies);
  assert.equal(wrongType.status, 415);
  const extraField = await handleApiRequest(request("POST", "/api/demo", { origin: TRUSTED_DASHBOARD_ORIGIN, "content-type": "application/json" }, '{"action":"start","secret":"value"}'), f.dependencies);
  assert.equal(extraField.status, 400);
  const oversized = await handleApiRequest(request("POST", "/api/demo", { origin: TRUSTED_DASHBOARD_ORIGIN, "content-type": "application/json" }, " ".repeat(1025)), f.dependencies);
  assert.equal(oversized.status, 413);
  const allowed = await handleApiRequest(request("POST", "/api/demo", { origin: TRUSTED_DASHBOARD_ORIGIN, "content-type": "application/json" }, '{"action":"start"}'), f.dependencies);
  assert.equal(allowed.status, 202);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], TRUSTED_DASHBOARD_ORIGIN);
  assert.equal(f.starts(), 1);
});

test("local demo start is rate limited after the first accepted run", async () => {
  const f = fixture();
  let now = 1_000;
  const dependencies: ApiDependencies = {
    ...f.dependencies,
    runner: {
      snapshot: () => ({ status: "idle", events: [] }),
      start: () => ({ status: "running", events: [] }),
    },
    demoStartLimiter: new DemoStartRateLimiter(30_000, () => now),
  };
  const headers = { origin: TRUSTED_DASHBOARD_ORIGIN, "content-type": "application/json" };
  const start = () => handleApiRequest(request("POST", "/api/demo", headers, '{"action":"start"}'), dependencies);

  assert.equal((await start()).status, 202);
  const limited = await start();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["Retry-After"], "30");
  now += 30_000;
  assert.equal((await start()).status, 202);
});
