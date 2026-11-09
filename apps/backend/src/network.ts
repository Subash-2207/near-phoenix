import { isLoopbackHttp, type JsonObject } from "./control-plane.js";

export type NearNetwork = "localnet" | "testnet" | "mainnet";
export interface NetworkConfig { network: NearNetwork; rpcUrl: string; explorerUrl: string | null }
export interface ContractStateInput { coreId: string; vaultId: string; agentId: string; taskId: string }
export interface OperatorActionInput { accountId: string; agentId: string; action: "heartbeat" | "report_crash" }
export interface DeploymentPreflightInput { accountId: string; publicKey: string; coreContractId: string; vaultContractId: string; expectedCoreCodeHash: string; expectedVaultCodeHash: string }
export interface RpcTransport { request<T>(url: string, method: string, params: unknown): Promise<T> }
export const TX_HASH_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{43,45}$/;
const ACCOUNT_PATTERN = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ZERO_CODE_HASH = "11111111111111111111111111111111";
const DEFAULTS: Record<NearNetwork, { rpc: string; explorer: string | null }> = {
  localnet: { rpc: "http://127.0.0.1:3030", explorer: null },
  testnet: { rpc: "https://rpc.testnet.near.org", explorer: "https://testnet.nearblocks.io" },
  mainnet: { rpc: "https://rpc.mainnet.near.org", explorer: "https://nearblocks.io" },
};

export function validAccountId(value: string): boolean { return ACCOUNT_PATTERN.test(value); }
export function explorerTransactionUrl(network: NearNetwork, hash: string): string | null {
  if (!TX_HASH_PATTERN.test(hash)) return null;
  const base = DEFAULTS[network].explorer;
  return base ? `${base}/txns/${encodeURIComponent(hash)}` : null;
}

export function resolveNetworkConfig(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const network = (env.NEAR_NETWORK ?? "localnet") as NearNetwork;
  if (!(["localnet", "testnet", "mainnet"] as string[]).includes(network)) throw new Error("NEAR_NETWORK must be localnet, testnet or mainnet");
  const selected = DEFAULTS[network];
  const rpcUrl = env.NEAR_RPC_URL ?? selected.rpc;
  let url: URL;
  try { url = new URL(rpcUrl); } catch { throw new Error("NEAR_RPC_URL is invalid"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("NEAR_RPC_URL must not contain credentials, query or fragment");
  if (network === "localnet") {
    if (!isLoopbackHttp(rpcUrl)) throw new Error("localnet RPC must use HTTP on loopback");
  } else {
    const expectedHost = network === "mainnet" ? "rpc.mainnet.near.org" : "rpc.testnet.near.org";
    if (url.protocol !== "https:" || url.hostname !== expectedHost || (url.port && url.port !== "443")) {
      throw new Error(`RPC URL does not match selected ${network} network`);
    }
  }
  return { network, rpcUrl, explorerUrl: selected.explorer };
}

interface RpcEnvelope<T> { result?: T; error?: { code?: number; message?: string; data?: unknown } }
export class FetchRpcTransport implements RpcTransport {
  async request<T>(url: string, method: string, params: unknown): Promise<T> {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "phoenix-stage-c", method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`NEAR ${method} returned HTTP ${response.status}`);
    const envelope = await response.json() as RpcEnvelope<T>;
    if (envelope.error) throw new Error(`NEAR ${method}: ${envelope.error.message ?? "RPC request failed"}`);
    if (!Object.hasOwn(envelope, "result")) throw new Error(`NEAR ${method} returned a malformed response`);
    return envelope.result as T;
  }
}

export interface NetworkServiceOptions { env?: NodeJS.ProcessEnv; transport?: RpcTransport }
export class NearNetworkService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: RpcTransport;
  constructor(options: NetworkServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.transport = options.transport ?? new FetchRpcTransport();
  }
  config(): NetworkConfig { return resolveNetworkConfig(this.env); }
  private async rpc<T>(config: NetworkConfig, method: string, params: unknown): Promise<T> {
    return this.transport.request<T>(config.rpcUrl, method, params);
  }
  async health() {
    const config = this.config();
    const status = await this.rpc<JsonObject>(config, "status", {});
    const chainId = status.chain_id;
    if (chainId !== config.network && !(config.network === "localnet" && chainId === "localnet")) {
      throw new Error(`RPC chain_id ${String(chainId)} does not match selected ${config.network}`);
    }
    const sync = status.sync_info !== null && typeof status.sync_info === "object" ? status.sync_info as JsonObject : {};
    return {
      network: config.network, chainId, connected: true,
      latestBlockHeight: sync.latest_block_height,
      latestBlockHash: sync.latest_block_hash,
      latestBlockTimestampNs: (() => {
        const time = sync.latest_block_time;
        if (typeof time !== "string") return undefined;
        if (/^[0-9]+$/.test(time)) return time;
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(time);
        if (!match || !Number.isFinite(Date.parse(match[1] + "Z"))) return undefined;
        return (BigInt(Date.parse(match[1] + "Z")) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"))).toString();
      })(),
      protocolVersion: status.protocol_version,
      observation: "NEAR RPC status response",
      observedAt: new Date().toISOString(),
    };
  }
  private async query<T>(config: NetworkConfig, params: JsonObject): Promise<{ value: T; blockHeight: number; blockHash: string }> {
    const result = await this.rpc<JsonObject>(config, "query", params);
    if (!result || !Number.isSafeInteger(result.block_height) || Number(result.block_height) < 0 || typeof result.block_hash !== "string" || !result.block_hash) throw new Error("Malformed NEAR query response");
    let value: unknown = result;
    if (params.request_type === "call_function") {
      if (!Array.isArray(result.result) || !result.result.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error("Malformed NEAR contract response");
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(result.result))) as T;
    } else if (Array.isArray(result.result)) {
      throw new Error("Malformed NEAR account/key response");
    }
    return { value: value as T, blockHeight: Number(result.block_height), blockHash: result.block_hash };
  }
  async account(accountId: string) {
    if (!validAccountId(accountId)) throw new Error("Invalid NEAR account ID");
    const config = this.config();
    const health = await this.health();
    const observed = await this.query<JsonObject>(config, { request_type: "view_account", finality: "final", account_id: accountId });
    return { network: config.network, chainId: health.chainId, accountId, amount: observed.value.amount, locked: observed.value.locked,
      storageUsage: observed.value.storage_usage, codeHash: observed.value.code_hash,
      blockHeight: observed.blockHeight, blockHash: observed.blockHash, verification: "finalized-rpc-observation" };
  }
  async contractState(input: ContractStateInput) {
    for (const id of [input.coreId, input.vaultId, input.agentId, input.taskId]) if (!validAccountId(id)) throw new Error("Invalid contract, agent or task account ID");
    const config = this.config();
    const health = await this.health();
    const core = await this.query<JsonObject>(config, { request_type: "view_account", finality: "final", account_id: input.coreId });
    const vault = await this.query<JsonObject>(config, { request_type: "view_account", block_id: core.blockHash, account_id: input.vaultId });
    if (vault.blockHash !== core.blockHash || vault.blockHeight !== core.blockHeight) throw new Error("RPC did not honor the pinned finalized contract-state block");
    if (core.value.code_hash === ZERO_CODE_HASH || vault.value.code_hash === ZERO_CODE_HASH) throw new Error("Configured PHOENIX or REWIND account has no deployed contract code");
    const pinned = (accountId: string, methodName: string, args: JsonObject) => this.query<unknown>(config, {
      request_type: "call_function", account_id: accountId, method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), block_id: core.blockHash,
    });
    const [agent, stateflow, task] = await Promise.all([
      pinned(input.coreId, "get_agent", { agent_id: input.agentId }),
      pinned(input.coreId, "get_stateflow", { agent_id: input.agentId }),
      pinned(input.vaultId, "get_task", { task_id: input.taskId }),
    ]);
    if ([agent, stateflow, task].some(observation => observation.blockHash !== core.blockHash || observation.blockHeight !== core.blockHeight)) throw new Error("RPC returned PHOENIX and REWIND state from different blocks");
    if (agent.value == null || stateflow.value == null || task.value == null) throw new Error("Configured contract, agent, STATEFLOW or REWIND task was not found");
    const generation = String((agent.value as JsonObject).generation ?? "");
    if (!/^\d+$/.test(generation)) throw new Error("Malformed on-chain recovery generation");
    const recovery = await pinned(input.coreId, "get_recovery_receipt", { agent_id: input.agentId, epoch_to: generation });
    if (recovery.blockHash !== core.blockHash || recovery.blockHeight !== core.blockHeight) throw new Error("RPC returned recovery receipt from a different finalized block");
    return { network: config.network, chainId: health.chainId, blockHeight: core.blockHeight, blockHash: core.blockHash,
      blockTimestampNs: health.latestBlockTimestampNs,
      verification: "finalized-rpc-observation", cryptographicProof: false,
      contracts: { phoenixCore: { accountId: input.coreId, codeHash: core.value.code_hash }, rewind: { accountId: input.vaultId, codeHash: vault.value.code_hash } },
      state: { agent: agent.value, stateflow: stateflow.value, task: task.value,
        proofOfRecovery: { currentEpoch: generation, receipt: recovery.value, status: recovery.value === null ? "no-receipt-at-current-epoch" : "returned-by-finalized-contract-view" } } };
  }
  async transaction(hash: string, senderAccountId: string) {
    if (!TX_HASH_PATTERN.test(hash)) throw new Error("Invalid NEAR transaction hash");
    if (!validAccountId(senderAccountId)) throw new Error("Invalid transaction sender account ID");
    const config = this.config();
    const health = await this.health();
    const result = await this.rpc<JsonObject>(config, "tx", {tx_hash: hash, sender_account_id: senderAccountId, wait_until: "FINAL"});
    const status = result.status !== null && typeof result.status === "object" ? result.status as JsonObject : {};
    const tx = result.transaction !== null && typeof result.transaction === "object" ? result.transaction as JsonObject : {};
    if (tx.hash !== hash || tx.signer_id !== senderAccountId) throw new Error("RPC transaction identity did not match the requested hash and sender");
    return { network: config.network, chainId: health.chainId, transactionHash: tx.hash, sender: tx.signer_id, receiver: tx.receiver_id,
      status, finalExecutionStatus: result.final_execution_status, transactionOutcome: result.transaction_outcome, receiptsOutcome: result.receipts_outcome,
      explorerUrl: explorerTransactionUrl(config.network, hash), verifiedBy: "selected-near-rpc", cryptographicProof: false };
  }
  readiness() {
    const config = this.config();
    const coreId = this.env.PHOENIX_CORE_ID ?? "";
    const codeHash = this.env.PHOENIX_CORE_CODE_HASH ?? "";
    const blockers: string[] = [];
    if (config.network === "localnet") blockers.push("Select testnet to validate the wallet workflow.");
    if (this.env.PHOENIX_ENABLE_WALLET_ACTIONS !== "true") blockers.push("Wallet actions are disabled in operator configuration.");
    if (!validAccountId(coreId)) blockers.push("Configure the deployed PHOENIX Core account.");
    if (!TX_HASH_PATTERN.test(codeHash) || codeHash === ZERO_CODE_HASH) blockers.push("Pin the reviewed PHOENIX Core code hash.");
    if (config.network === "mainnet" && this.env.PHOENIX_ENABLE_MAINNET_ACTIONS !== "reviewed") blockers.push("Mainnet actions require explicit reviewed operator configuration.");
    return { network: config.network, coreId, expectedCodeHash: codeHash, enabled: blockers.length === 0,
      supportedActions: ["heartbeat", "report_crash"], blockers, serverHoldsKeys: false, serverBroadcasts: false };
  }
  async prepareOperatorAction(input: OperatorActionInput) {
    if (!input || typeof input !== "object" || Object.keys(input).some(k => !["accountId", "agentId", "action"].includes(k)) ||
        typeof input.accountId !== "string" || typeof input.agentId !== "string" || !validAccountId(input.accountId) || !validAccountId(input.agentId) ||
        !["heartbeat", "report_crash"].includes(input.action)) throw new Error("Invalid operator action or account identifiers");
    const policy = this.readiness();
    if (!policy.enabled) throw new Error(policy.blockers.join(" "));
    const config = this.config();
    const health = await this.health();
    const core = await this.query<JsonObject>(config, {request_type: "view_account", finality: "final", account_id: policy.coreId});
    if (core.value.code_hash !== policy.expectedCodeHash) throw new Error("Deployed contract code does not match the pinned reviewed hash");
    const pinned = (params: JsonObject) => this.query<unknown>(config, {...params, block_id: core.blockHash});
    const [agentView, pausedView, signer, block] = await Promise.all([
      pinned({request_type: "call_function", account_id: policy.coreId, method_name: "get_agent", args_base64: Buffer.from(JSON.stringify({agent_id: input.agentId})).toString("base64")}),
      pinned({request_type: "call_function", account_id: policy.coreId, method_name: "is_paused", args_base64: "e30="}),
      pinned({request_type: "view_account", account_id: input.accountId}),
      this.rpc<JsonObject>(config, "block", {block_id: core.blockHash}),
    ]);
    if ([agentView, pausedView, signer].some(o => o.blockHash !== core.blockHash || o.blockHeight !== core.blockHeight)) throw new Error("RPC did not honor the pinned action-review block");
    const header = block?.header as JsonObject | undefined;
    if (!header || header.hash !== core.blockHash || header.height !== core.blockHeight) throw new Error("RPC returned a different action-review block");
    if (pausedView.value !== false) throw new Error("PHOENIX Core is paused or its status is unavailable");
    const agent = agentView.value as JsonObject | null;
    if (!agent || agent.status !== "Running") throw new Error("Action requires a running registered agent");
    const u64 = (value: unknown) => {
      if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw new Error("Malformed on-chain epoch or time");
      return BigInt(value);
    };
    const generation = u64(agent.generation);
    const heartbeat = u64(agent.heartbeat_at); const timeout = u64(agent.timeout_ns); const chainTime = u64(header.timestamp_nanosec);
    if (timeout === 0n || chainTime < heartbeat) throw new Error("Invalid on-chain heartbeat timing");
    const expired = chainTime - heartbeat >= timeout;
    if (input.action === "heartbeat" && (agent.operator !== input.accountId || expired)) throw new Error("Heartbeat requires the registered operator and an unexpired heartbeat");
    if (input.action === "report_crash" && !expired) throw new Error("Crash reporting requires an expired on-chain heartbeat");
    const account = signer.value as JsonObject;
    if (!account || typeof account.amount !== "string" || !/^[0-9]+$/.test(account.amount) || BigInt(account.amount) === 0n) throw new Error("Signer account requires a NEAR balance for network fees");
    const args = input.action === "heartbeat" ? {agent_id: input.agentId, generation: String(generation)} : {agent_id: input.agentId};
    return {
      version: 1, network: config.network, chainId: health.chainId,
      preparedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
      observedBlock: {height: core.blockHeight, hash: core.blockHash}, expectedCodeHash: policy.expectedCodeHash,
      transaction: {signerId: input.accountId, receiverId: policy.coreId,
        actions: [{type: "FunctionCall" as const, params: {methodName: input.action, args, gas: "30000000000000", deposit: "0"}}]},
      limits: {attachedDeposit: "0", gasTgas: 30, arbitraryCalls: false, transfers: false},
      verification: "finalized-rpc-observation", serverBroadcasts: false,
    };
  }
  async deploymentPreflight(input: DeploymentPreflightInput) {
    for (const id of [input.accountId, input.coreContractId, input.vaultContractId]) if (!validAccountId(id)) throw new Error("Invalid deployment account ID");
    if (input.coreContractId === input.vaultContractId) throw new Error("PHOENIX Core and REWIND must use separate accounts");
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(input.publicKey)) throw new Error("A public ed25519 access key is required; never submit a private key");
    for (const hash of [input.expectedCoreCodeHash, input.expectedVaultCodeHash]) if (!/^[1-9A-HJ-NP-Za-km-z]{42,45}$/.test(hash)) throw new Error("Expected code hashes must be canonical NEAR base58 hashes");
    const config = this.config();
    if (config.network !== "mainnet") throw new Error("Mainnet deployment preflight requires explicit NEAR_NETWORK=mainnet");
    const health = await this.health();
    const signer = await this.query<JsonObject>(config, { request_type: "view_account", finality: "final", account_id: input.accountId });
    const access = await this.query<JsonObject>(config, { request_type: "view_access_key", block_id: signer.blockHash, account_id: input.accountId, public_key: input.publicKey });
    const core = await this.query<JsonObject>(config, { request_type: "view_account", block_id: signer.blockHash, account_id: input.coreContractId });
    const vault = await this.query<JsonObject>(config, { request_type: "view_account", block_id: signer.blockHash, account_id: input.vaultContractId });
    if ([access, core, vault].some(observation => observation.blockHash !== signer.blockHash || observation.blockHeight !== signer.blockHeight)) throw new Error("RPC did not honor the pinned preflight block");
    const permission = access.value.permission;
    const fullAccess = permission === "FullAccess" || (permission !== null && typeof permission === "object" && Object.hasOwn(permission as object, "FullAccess"));
    const coreCode = String(core.value.code_hash); const vaultCode = String(vault.value.code_hash);
    const coreReady = coreCode === ZERO_CODE_HASH || coreCode === input.expectedCoreCodeHash;
    const vaultReady = vaultCode === ZERO_CODE_HASH || vaultCode === input.expectedVaultCodeHash;
    return { network: config.network, chainId: health.chainId, blockHeight: signer.blockHeight, blockHash: signer.blockHash,
      signerAccount: input.accountId, signerHasFullAccessKey: fullAccess,
      targets: [
        { accountId: input.coreContractId, currentCodeHash: coreCode, expectedCodeHash: input.expectedCoreCodeHash, compatible: coreReady },
        { accountId: input.vaultContractId, currentCodeHash: vaultCode, expectedCodeHash: input.expectedVaultCodeHash, compatible: vaultReady },
      ],
      readyForManualReview: fullAccess && coreReady && vaultReady,
      transactionsBroadcast: false, privateKeyRequested: false,
      warning: "Read-only preflight only. No deployment transaction was created or submitted." };
  }
}
