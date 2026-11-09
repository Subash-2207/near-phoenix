import { test } from "node:test";
import assert from "node:assert/strict";
import { explorerTransactionUrl, NearNetworkService, resolveNetworkConfig, type RpcTransport } from "./network.js";

const HASH = "11111111111111111111111111111111111111111111";
const CODE = "11111111111111111111111111111111111111111111";
function query(value: unknown) { return { result: [...Buffer.from(JSON.stringify(value))], block_height: 700, block_hash: "final-block-hash" }; }
function view(value: Record<string, unknown>) { return { ...value, block_height: 700, block_hash: "final-block-hash" }; }
const mainnetStatus = { chain_id: "mainnet", protocol_version: 88, sync_info: { latest_block_height: 700, latest_block_hash: "final-block-hash", latest_block_time: "1800000000000000000" } };
class FakeRpc implements RpcTransport {
  calls: Array<{ url: string; method: string; params: unknown }> = [];
  responses: unknown[] = [];
  async request<T>(url: string, method: string, params: unknown): Promise<T> {
    this.calls.push({ url, method, params });
    return this.responses.shift() as T;
  }
}

test("network configuration isolates localnet, testnet and mainnet and rejects mismatched RPC hosts", () => {
  assert.equal(resolveNetworkConfig({ NEAR_NETWORK: "mainnet" }).rpcUrl, "https://rpc.mainnet.near.org");
  assert.equal(resolveNetworkConfig({ NEAR_NETWORK: "testnet" }).rpcUrl, "https://rpc.testnet.near.org");
  assert.throws(() => resolveNetworkConfig({ NEAR_NETWORK: "mainnet", NEAR_RPC_URL: "https://rpc.testnet.near.org" }), /does not match/);
  assert.throws(() => resolveNetworkConfig({ NEAR_NETWORK: "mainnet", NEAR_RPC_URL: "http://rpc.mainnet.near.org" }), /does not match/);
  assert.throws(() => resolveNetworkConfig({ NEAR_NETWORK: "localnet", NEAR_RPC_URL: "https://example.org" }), /loopback/);
  const credentialUrl = new URL("https://rpc.mainnet.near.org");
  credentialUrl.username = "test-user";
  credentialUrl.password = "not-a-secret";
  assert.throws(() => resolveNetworkConfig({ NEAR_NETWORK: "mainnet", NEAR_RPC_URL: credentialUrl.toString() }), /credentials/);
});

test("health identifies actual chain and rejects a network mismatch", async () => {
  const rpc = new FakeRpc();
  rpc.responses.push({ chain_id: "mainnet", protocol_version: 88, sync_info: { latest_block_height: 700, latest_block_hash: "final", latest_block_time: "1800000000000000000" } });
  const result = await new NearNetworkService({ env: { NEAR_NETWORK: "mainnet" }, transport: rpc }).health();
  assert.equal(result.chainId, "mainnet");
  assert.equal(result.latestBlockHeight, 700);
  const wrong = new FakeRpc(); wrong.responses.push({ chain_id: "testnet" });
  await assert.rejects(() => new NearNetworkService({ env: { NEAR_NETWORK: "mainnet" }, transport: wrong }).health(), /does not match/);
});

test("account and contract views are tagged with a shared finalized block and code identity", async () => {
  const rpc = new FakeRpc();
  rpc.responses.push(mainnetStatus, view({ amount: "10", locked: "0", storage_usage: 5, code_hash: CODE }));
  const account = await new NearNetworkService({ env: { NEAR_NETWORK: "mainnet" }, transport: rpc }).account("alice.near");
  assert.equal(account.verification, "finalized-rpc-observation");
  assert.equal(account.blockHeight, 700);
  assert.equal(account.amount, "10");
  const contractRpc = new FakeRpc();
  contractRpc.responses.push(mainnetStatus, view({ code_hash: CODE }), view({ code_hash: CODE }), query({ status: "Running", generation: "2" }), query({ head: null }), query({ paid: "0" }), query({ task_id: "task-1", epoch_to: "2", checkpoint_hash: "ab".repeat(32) }));
  const state = await new NearNetworkService({ env: { NEAR_NETWORK: "mainnet" }, transport: contractRpc }).contractState({ coreId: "core.near", vaultId: "vault.near", agentId: "agent.near", taskId: "task-1" });
  assert.equal(state.blockHash, "final-block-hash");
  assert.equal(state.cryptographicProof, false);
  assert.equal(state.state.agent && (state.state.agent as Record<string, unknown>).status, "Running");
  assert.equal(((state.state.proofOfRecovery as Record<string, unknown>).receipt as Record<string, unknown>).task_id, "task-1");
  const viewCalls = contractRpc.calls.slice(3);
  assert.ok(viewCalls.every(call => (call.params as Record<string, unknown>).block_id === "final-block-hash"));
});

test("invalid account IDs, absent contract code and forged transaction identities fail closed", async () => {
  const rpc = new FakeRpc();
  const service = new NearNetworkService({ env: { NEAR_NETWORK: "mainnet" }, transport: rpc });
  await assert.rejects(() => service.account("https://evil.example"), /Invalid NEAR account/);
  rpc.responses.push(mainnetStatus, view({ code_hash: "11111111111111111111111111111111" }), view({ code_hash: CODE }));
  await assert.rejects(() => service.contractState({ coreId: "core.near", vaultId: "vault.near", agentId: "agent.near", taskId: "task" }), /no deployed contract/);
  await assert.rejects(() => service.transaction("not-a-hash", "alice.near"), /Invalid NEAR transaction hash/);
  rpc.responses.push(mainnetStatus, { transaction: { hash: HASH, signer_id: "mallory.near" }, status: { SuccessValue: "" } });
  await assert.rejects(() => service.transaction(HASH, "alice.near"), /identity did not match/);
});

test("transaction explorer links require a valid hash and use network-specific explorer", () => {
  assert.equal(explorerTransactionUrl("mainnet", HASH), `https://nearblocks.io/txns/${HASH}`);
  assert.equal(explorerTransactionUrl("testnet", HASH), `https://testnet.nearblocks.io/txns/${HASH}`);
  assert.equal(explorerTransactionUrl("localnet", HASH), null);
  assert.equal(explorerTransactionUrl("mainnet", "fake"), null);
});

test("mainnet deployment preflight checks on-chain signer permissions and broadcasts nothing", async () => {
  const rpc = new FakeRpc();
  rpc.responses.push(
    mainnetStatus,
    view({ amount: "100", code_hash: CODE }),
    view({ permission: "FullAccess" }),
    view({ code_hash: "11111111111111111111111111111111" }),
    view({ code_hash: "11111111111111111111111111111111" }),
  );
  const service = new NearNetworkService({ env: { NEAR_NETWORK: "mainnet" }, transport: rpc });
  const result = await service.deploymentPreflight({ accountId: "owner.near", publicKey: `ed25519:${"1".repeat(44)}`, coreContractId: "core.near", vaultContractId: "vault.near", expectedCoreCodeHash: CODE, expectedVaultCodeHash: CODE });
  assert.equal(result.readyForManualReview, true);
  assert.equal(result.transactionsBroadcast, false);
  assert.equal(result.privateKeyRequested, false);
  await assert.rejects(() => service.deploymentPreflight({ accountId: "owner.near", publicKey: "private-key", coreContractId: "core.near", vaultContractId: "vault.near", expectedCoreCodeHash: CODE, expectedVaultCodeHash: CODE }), /public ed25519 access key/);
  await assert.rejects(() => new NearNetworkService({ env: { NEAR_NETWORK: "testnet" }, transport: rpc }).deploymentPreflight({ accountId: "owner.testnet", publicKey: `ed25519:${"1".repeat(44)}`, coreContractId: "core.testnet", vaultContractId: "vault.testnet", expectedCoreCodeHash: CODE, expectedVaultCodeHash: CODE }), /requires explicit NEAR_NETWORK=mainnet/);
});

test("preflight reports mismatched deployed code and insufficient signer permission", async () => {
  const rpc = new FakeRpc();
  rpc.responses.push(
    mainnetStatus,
    view({ amount: "100" }),
    view({ permission: { FunctionCall: { receiver_id: "core.near", method_names: ["get_agent"], allowance: null } } }),
    view({ code_hash: "22222222222222222222222222222222222222222222" }),
    view({ code_hash: "11111111111111111111111111111111" }),
  );
  const result = await new NearNetworkService({ env: { NEAR_NETWORK: "mainnet" }, transport: rpc }).deploymentPreflight({ accountId: "owner.near", publicKey: `ed25519:${"1".repeat(44)}`, coreContractId: "core.near", vaultContractId: "vault.near", expectedCoreCodeHash: CODE, expectedVaultCodeHash: CODE });
  assert.equal(result.signerHasFullAccessKey, false);
  assert.equal(result.targets[0]?.compatible, false);
  assert.equal(result.readyForManualReview, false);
  assert.equal(result.transactionsBroadcast, false);
});

const actionEnv = {NEAR_NETWORK: "testnet", PHOENIX_ENABLE_WALLET_ACTIONS: "true", PHOENIX_CORE_ID: "core.testnet", PHOENIX_CORE_CODE_HASH: CODE};
const testnetStatus = {...mainnetStatus, chain_id: "testnet"};
function actionRpc(overrides: Record<string, unknown> = {}, code = CODE, paused: unknown = false) {
  const rpc = new FakeRpc();
  rpc.responses.push(testnetStatus, view({code_hash: code}),
    query({status: "Running", operator: "operator.testnet", generation: "9007199254740993", heartbeat_at: "1000", timeout_ns: "10000", ...overrides}),
    query(paused), view({amount: "1000000000000000000000000"}),
    {header: {hash: "final-block-hash", height: 700, timestamp_nanosec: "2000"}});
  return rpc;
}
test("operator preparation is opt-in, network gated and never signs or broadcasts", async () => {
  assert.equal(new NearNetworkService({env: {NEAR_NETWORK: "testnet"}}).readiness().enabled, false);
  assert.equal(new NearNetworkService({env: {...actionEnv, NEAR_NETWORK: "mainnet"}}).readiness().enabled, false);
  const rpc = actionRpc();
  const plan = await new NearNetworkService({env: actionEnv, transport: rpc}).prepareOperatorAction({accountId: "operator.testnet", agentId: "agent.testnet", action: "heartbeat"});
  assert.equal(plan.transaction.actions[0].params.deposit, "0");
  assert.equal(plan.transaction.actions[0].params.gas, "30000000000000");
  assert.equal(plan.transaction.actions[0].params.args.generation, "9007199254740993");
  assert.equal(plan.serverBroadcasts, false);
  assert.ok(rpc.calls.every(c => ["status", "query", "block"].includes(c.method)));
  assert.ok(rpc.calls.slice(2).every(c => (c.params as Record<string, unknown>).block_id === "final-block-hash"));
});
test("action policy rejects unknown methods, a changed contract, a paused contract and the wrong operator", async () => {
  const svc = (rpc: FakeRpc) => new NearNetworkService({env: actionEnv, transport: rpc});
  await assert.rejects(() => svc(actionRpc()).prepareOperatorAction({accountId: "operator.testnet", agentId: "agent.testnet", action: "transfer"} as never), /Invalid operator/);
  await assert.rejects(() => svc(actionRpc({}, "22222222222222222222222222222222222222222222")).prepareOperatorAction({accountId: "operator.testnet", agentId: "agent.testnet", action: "heartbeat"}), /pinned reviewed hash/);
  await assert.rejects(() => svc(actionRpc({}, CODE, true)).prepareOperatorAction({accountId: "operator.testnet", agentId: "agent.testnet", action: "heartbeat"}), /paused/);
  await assert.rejects(() => svc(actionRpc()).prepareOperatorAction({accountId: "attacker.testnet", agentId: "agent.testnet", action: "heartbeat"}), /registered operator/);
});
test("heartbeat expiry and crash reporting follow chain time, not browser time", async () => {
  const service = (overrides: Record<string, unknown>) => new NearNetworkService({env: actionEnv, transport: actionRpc(overrides)});
  await assert.rejects(() => service({timeout_ns: "1000"}).prepareOperatorAction({accountId: "operator.testnet", agentId: "agent.testnet", action: "heartbeat"}), /unexpired heartbeat/);
  await assert.rejects(() => service({}).prepareOperatorAction({accountId: "operator.testnet", agentId: "agent.testnet", action: "report_crash"}), /expired on-chain heartbeat/);
  const plan = await service({timeout_ns: "1000"}).prepareOperatorAction({accountId: "observer.testnet", agentId: "agent.testnet", action: "report_crash"});
  assert.deepEqual(plan.transaction.actions[0].params.args, {agent_id: "agent.testnet"});
});
test("mixed finalized blocks and malformed U64 state reject action preparation", async () => {
  const rpc = actionRpc(); (rpc.responses[3] as Record<string, unknown>).block_hash = "different-block";
  await assert.rejects(() => new NearNetworkService({env: actionEnv, transport: rpc}).prepareOperatorAction({accountId: "operator.testnet", agentId: "agent.testnet", action: "heartbeat"}), /pinned action-review block/);
  await assert.rejects(() => new NearNetworkService({env: actionEnv, transport: actionRpc({generation: "18446744073709551616"})}).prepareOperatorAction({accountId: "operator.testnet", agentId: "agent.testnet", action: "heartbeat"}), /Malformed on-chain/);
});
test("RPC account decoding rejects the old, incorrect byte-array account shape", async () => {
  const rpc = new FakeRpc(); rpc.responses.push(mainnetStatus, query({amount: "100"}));
  await assert.rejects(() => new NearNetworkService({env: {NEAR_NETWORK: "mainnet"}, transport: rpc}).account("operator.near"), /Malformed NEAR account/);
});
test("ISO RPC timestamps preserve nanosecond precision and tx requests wait for finality", async () => {
  const rpc = new FakeRpc();rpc.responses.push({...mainnetStatus, sync_info: {...mainnetStatus.sync_info, latest_block_time: "2026-11-08T05:13:23.553833584Z"}});
  const health = await new NearNetworkService({env: {NEAR_NETWORK: "mainnet"}, transport: rpc}).health();
  assert.equal(health.latestBlockTimestampNs, (BigInt(Date.parse("2026-11-08T05:13:23Z")) * 1000000n + 553833584n).toString());
  rpc.responses.push(mainnetStatus, {transaction: {hash: HASH, signer_id: "alice.near", receiver_id: "core.near"}, final_execution_status: "FINAL", status: {SuccessValue: ""}});
  const result = await new NearNetworkService({env: {NEAR_NETWORK: "mainnet"}, transport: rpc}).transaction(HASH, "alice.near");
  assert.equal(result.finalExecutionStatus, "FINAL");assert.deepEqual(rpc.calls.at(-1)?.params, {tx_hash: HASH, sender_account_id: "alice.near", wait_until: "FINAL"});
});
