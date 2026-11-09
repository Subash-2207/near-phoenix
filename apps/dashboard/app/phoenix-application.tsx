"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { NearConnector } from "@hot-labs/near-connect";
import { TransactionWorkbench } from "./components/transaction-workbench";
import {
  walletNetworkMatches,
  walletSessionTransition,
} from "./wallet-session.mjs";
import { deriveEvidenceMetrics } from "./evidence-metrics.mjs";
import { AnimatePresence, motion } from "motion/react";
import { useMotionPreferences } from "./components/motion-preferences";
import { CommandShell } from "./components/command-shell";
import {
  MotionProvider,
  Reveal,
  AnimatedNumber,
  CopyButton,
  Icon,
  MagneticButton,
  TiltSection,
} from "./components/ui";
import { RecoveryNetwork } from "./components/recovery-network";
import { MonolithOverview } from "./components/monolith-overview";
import { isDashboardSection } from "./sections";
import {
  EvidenceChart,
  EvidenceDisclosure,
  MethodFlow,
} from "./components/evidence-panels";

const API_URL = new URL(
  process.env.NEXT_PUBLIC_PHOENIX_API_URL ?? "http://127.0.0.1:3001",
);
if (API_URL.protocol !== "http:" || API_URL.hostname !== "127.0.0.1")
  throw new Error("PHOENIX API must be a loopback HTTP endpoint");
const API = API_URL.origin;
type State = {
  source?: string;
  configured?: boolean;
  observedAt?: string;
  error?: string;
  chain?: { blockHeight: number; blockTimestampNs?: string };
  agent?: Record<string, unknown> | null;
  checkpoint?: Record<string, unknown> | null;
  proofOfRecovery?: Record<string, unknown> | null;
  backupActivation?: Record<string, unknown> | null;
  sentinel?: Record<string, unknown> | null;
  guardian?: Record<string, unknown> | null;
  escrow?: Record<string, unknown> | null;
};
type NetworkHealth = {
  network: string;
  chainId?: unknown;
  connected?: boolean;
  latestBlockHeight?: unknown;
  latestBlockHash?: unknown;
  latestBlockTimestampNs?: unknown;
  protocolVersion?: unknown;
  error?: string;
};
type Demo = {
  status: "idle" | "running" | "succeeded" | "failed";
  error?: string;
  events: Array<{
    id: number;
    at: string;
    kind: string;
    details: Record<string, unknown>;
  }>;
};
type WalletSession = {
  status: "disconnected" | "connecting" | "connected" | "error";
  accountId: string | null;
  network: string | null;
  error: string | null;
};
type WalletRuntime = { connector: NearConnector; networkId: "mainnet" | "testnet" };
let runtimeNetwork: string | null = null;
let runtimePromise: Promise<WalletRuntime> | null = null;
function getWalletRuntime(networkId: "mainnet" | "testnet"): Promise<WalletRuntime> {
  if (runtimePromise) {
    if (runtimeNetwork !== networkId) return Promise.reject(new Error("Network changed. Reload before reconnecting."));
    return runtimePromise;
  }
  runtimeNetwork = networkId;
  runtimePromise = (async () => {
    const { NearConnector } = await import("@hot-labs/near-connect");
    const connector = new NearConnector({ network: networkId, autoConnect: false,
      features: { signInWithoutAddKey: true, signAndSendTransaction: true, [networkId]: true } });
    await connector.whenManifestLoaded;
    return { connector, networkId };
  })().catch(error => { runtimePromise = null; runtimeNetwork = null; throw error; });
  return runtimePromise;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    cache: "no-store",
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
function show(value: unknown): string {
  if (value === null || value === undefined || value === "")
    return "Not reported";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function Card({
  title,
  children,
  accent = "blue",
  interactive = false,
}: {
  title: string;
  children: React.ReactNode;
  accent?: string;
  interactive?: boolean;
}) {
  const contents = (
    <>
      <h3>{title}</h3>
      {children}
    </>
  );
  return interactive ? (
    <TiltSection className="card card-tilt" accent={accent}>
      {contents}
    </TiltSection>
  ) : (
    <section className="card" data-accent={accent}>
      {contents}
    </section>
  );
}
function Field({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="field">
      <span>{label}</span>
      <strong title={show(value)}>
        {show(value)}
        {typeof value === "string" && value.length > 24 && (
          <CopyButton value={value} label={`Copy ${label}`} />
        )}
      </strong>
    </div>
  );
}

export default function PhoenixApplication() {
  const pathname = usePathname();
  const router = useRouter();
  const routeSection = pathname.split("/").filter(Boolean)[0] ?? "overview";
  const active = isDashboardSection(routeSection) ? routeSection : "overview";
  const { reduceMotion } = useMotionPreferences();
  const [polled, setPolled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const previousActive = useRef(active);
  useEffect(() => {
    if (previousActive.current === active) return;
    previousActive.current = active;
    window.requestAnimationFrame(() =>
      viewRef.current?.focus({ preventScroll: true }),
    );
  }, [active]);
  function navigate(id: string) {
    if (!isDashboardSection(id)) return;
    router.push(id === "overview" ? "/" : `/${id}`);
  }
  const [state, setState] = useState<State | null>(null);
  const [demo, setDemo] = useState<Demo>({ status: "idle", events: [] });
  const [backendError, setBackendError] = useState("");
  const [starting, setStarting] = useState(false);
  const [networkHealth, setNetworkHealth] = useState<NetworkHealth | null>(
    null,
  );
  const [networkError, setNetworkError] = useState("");
  const [walletSession, setWalletSession] = useState<WalletSession>({
    status: "disconnected",
    accountId: null,
    network: null,
    error: null,
  });
  const [walletReady, setWalletReady] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletAccountInfo, setWalletAccountInfo] = useState<Record<
    string,
    unknown
  > | null>(null);
  const walletHealthRef = useRef<NetworkHealth | null>(null);
  const walletRuntimeRef = useRef<WalletRuntime | null>(null);
  const [accountInput, setAccountInput] = useState("");
  const [accountResult, setAccountResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [accountError, setAccountError] = useState("");
  const [accountLoading, setAccountLoading] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [txSender, setTxSender] = useState("");
  const [txResult, setTxResult] = useState<Record<string, unknown> | null>(
    null,
  );
  const [txError, setTxError] = useState("");
  const [txLoading, setTxLoading] = useState(false);
  const [contractResult, setContractResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [contractError, setContractError] = useState("");
  const [contractLoading, setContractLoading] = useState(false);
  const [preflight, setPreflight] = useState<Record<string, unknown> | null>(
    null,
  );
  const [preflightError, setPreflightError] = useState("");
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightFields, setPreflightFields] = useState({
    accountId: "",
    publicKey: "",
    coreContractId: "",
    vaultContractId: "",
    expectedCoreCodeHash: "",
    expectedVaultCodeHash: "",
  });
  const configuredContractIds = {
    coreId: process.env.NEXT_PUBLIC_PHOENIX_CORE_ID ?? "",
    vaultId: process.env.NEXT_PUBLIC_REWIND_VAULT_ID ?? "",
    agentId: process.env.NEXT_PUBLIC_PHOENIX_AGENT_ID ?? "",
    taskId: process.env.NEXT_PUBLIC_PHOENIX_TASK_ID ?? "",
  };
  const refresh = useCallback(async () => {
    try {
      const [next, progress] = await Promise.all([
        getJson<State>("/api/control-plane"),
        getJson<Demo>("/api/demo"),
      ]);
      setState(next);
      setDemo(progress);
      setBackendError("");
    } catch (error) {
      setBackendError(
        error instanceof Error ? error.message : "Backend unavailable",
      );
    } finally {
      setPolled(true);
    }
    try {
      const health = await getJson<NetworkHealth>("/api/network/health");
      walletHealthRef.current = health;
      setNetworkHealth(health);
      setNetworkError("");
    } catch (error) {
      walletHealthRef.current = null;
      setNetworkHealth(null);

      setWalletBusy(false);
      setWalletSession((current) =>
        current.status !== "disconnected"
          ? walletSessionTransition(current, { type: "network-mismatch" })
          : current,
      );
      setNetworkError(
        error instanceof Error ? error.message : "NEAR RPC unavailable",
      );
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: number;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(poll, 4000);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cleanup = () => {};
    const health = networkHealth;
    if (!health || !walletNetworkMatches(health, health.network)) {
      setWalletReady(false);
      walletRuntimeRef.current = null;
      setWalletSession(current => current.status === "connected" ? walletSessionTransition(current, { type: "network-mismatch" }) : current);
      return;
    }
    void getWalletRuntime(health.network as "mainnet" | "testnet").then(async runtime => {
      if (!active) return;
      walletRuntimeRef.current = runtime;
      setWalletReady(true);
      const sync = async () => {
        try {
          const wallet = await runtime.connector.wallet();
          const accounts = await wallet.getAccounts({ network: runtime.networkId });
          if (!active) return;
          setWalletSession(current => walletSessionTransition(current, accounts[0]
            ? { type: "connected", health: walletHealthRef.current, walletNetworkId: runtime.connector.network, accountId: accounts[0].accountId }
            : { type: "disconnected" }));
        } catch { if (active) setWalletSession(current => current.status === "connecting" ? current : walletSessionTransition(current, { type: "disconnected" })); }
      };
      const onIn = () => { if (!active) return; setWalletBusy(false); void sync(); };
      const onOut = () => { if (!active) return; setWalletSession(current => walletSessionTransition(current, { type: "disconnected" })); };
      runtime.connector.on("wallet:signIn", onIn);
      runtime.connector.on("wallet:signOut", onOut);
      cleanup = () => { runtime.connector.off("wallet:signIn", onIn); runtime.connector.off("wallet:signOut", onOut); };
      await sync();
      if (active) timer = setInterval(() => { if (!document.hidden) void sync(); }, 5000);
    }).catch(error => { if (active) { setWalletReady(false); setWalletSession({status: "error", accountId: null, network: null, error: error instanceof Error ? error.message : "Wallet connector unavailable"}); } });
    return () => { active = false; cleanup(); if (timer) clearInterval(timer); };
  }, [networkHealth?.network, networkHealth?.chainId, networkHealth?.connected]);

  useEffect(() => {
    const accountId =
      walletSession.status === "connected" &&
      walletSession.accountId &&
      walletNetworkMatches(networkHealth, walletSession.network ?? "")
        ? walletSession.accountId
        : null;
    if (!accountId || !networkHealth) {
      setWalletAccountInfo(null);
      return;
    }
    let active = true;
    void getJson<Record<string, unknown>>(
      `/api/network/account?accountId=${encodeURIComponent(accountId)}`,
    )
      .then((info) => {
        if (!active) return;
        if (
          info.network !== walletSession.network ||
          info.chainId !== networkHealth.chainId
        )
          throw new Error("Wallet account RPC network changed during lookup.");
        setWalletAccountInfo(info);
      })
      .catch((error) => {
        if (active)
          setWalletAccountInfo({
            error:
              error instanceof Error
                ? error.message
                : "Wallet account lookup failed.",
          });
      });
    return () => {
      active = false;
    };
  }, [
    walletSession.status,
    walletSession.accountId,
    walletSession.network,
    networkHealth?.network,
    networkHealth?.chainId,
  ]);

  async function startDemo() {
    setStarting(true);
    try {
      const response = await fetch(`${API}/api/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
        credentials: "omit",
      });
      const value = (await response.json()) as Demo & { error?: string };
      if (!response.ok)
        throw new Error(
          value.error ?? `Backend returned HTTP ${response.status}`,
        );
      setDemo(value);
      setBackendError("");
    } catch (error) {
      setBackendError(
        error instanceof Error
          ? error.message
          : "Could not start sandbox demonstration",
      );
    } finally {
      setStarting(false);
    }
  }
  async function lookupAccount(event: React.FormEvent) {
    event.preventDefault();
    setAccountError("");
    setAccountResult(null);
    setAccountLoading(true);
    try {
      setAccountResult(
        await getJson<Record<string, unknown>>(
          `/api/network/account?accountId=${encodeURIComponent(accountInput.trim())}`,
        ),
      );
    } catch (error) {
      setAccountError(
        error instanceof Error ? error.message : "Account lookup failed",
      );
    } finally {
      setAccountLoading(false);
    }
  }
  async function lookupTransaction(event: React.FormEvent) {
    event.preventDefault();
    setTxError("");
    setTxResult(null);
    setTxLoading(true);
    try {
      setTxResult(
        await getJson<Record<string, unknown>>(
          `/api/network/transaction?hash=${encodeURIComponent(txHash.trim())}&sender=${encodeURIComponent(txSender.trim())}`,
        ),
      );
    } catch (error) {
      setTxError(
        error instanceof Error ? error.message : "Transaction lookup failed",
      );
    } finally {
      setTxLoading(false);
    }
  }
  async function lookupContracts() {
    setContractError("");
    setContractResult(null);
    setContractLoading(true);
    const query = new URLSearchParams(configuredContractIds);
    try {
      setContractResult(
        await getJson<Record<string, unknown>>(
          `/api/network/contract-state?${query}`,
        ),
      );
    } catch (error) {
      setContractError(
        error instanceof Error ? error.message : "Contract state lookup failed",
      );
    } finally {
      setContractLoading(false);
    }
  }
  async function runPreflight(event: React.FormEvent) {
    event.preventDefault();
    setPreflightError("");
    setPreflight(null);
    setPreflightLoading(true);
    try {
      const response = await fetch(`${API}/api/network/deployment-preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(preflightFields),
        credentials: "omit",
        cache: "no-store",
      });
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : `Preflight returned HTTP ${response.status}`,
        );
      setPreflight(result);
    } catch (error) {
      setPreflightError(
        error instanceof Error ? error.message : "Deployment preflight failed",
      );
    } finally {
      setPreflightLoading(false);
    }
  }
  async function connectWallet() {
    const runtime = walletRuntimeRef.current;
    if (!runtime || !walletNetworkMatches(walletHealthRef.current, runtime.networkId)) {
      setWalletSession(current => walletSessionTransition(current, { type: "network-mismatch" })); return;
    }
    setWalletBusy(true);
    setWalletSession(current => walletSessionTransition(current, { type: "connecting" }));
    try {
      const wallet = await runtime.connector.connect();
      const accounts = await wallet.getAccounts({ network: runtime.networkId });
      setWalletSession(current => walletSessionTransition(current, {type: "connected", health: walletHealthRef.current, walletNetworkId: runtime.connector.network, accountId: accounts[0]?.accountId}));
    } catch (error) {
      setWalletSession({status: "error", accountId: null, network: null, error: error instanceof Error ? error.message : "Wallet connection cancelled. No action was submitted."});
    } finally { setWalletBusy(false); }
  }
  async function disconnectWallet() {
    const runtime = walletRuntimeRef.current;
    if (!runtime) return;
    setWalletBusy(true);
    try { await runtime.connector.disconnect(); setWalletSession(current => walletSessionTransition(current, {type: "disconnected"})); }
    catch (error) { setWalletSession(current => ({...current, error: error instanceof Error ? error.message : "Disconnect failed"})); }
    finally { setWalletBusy(false); }
  }

  const usableContract =
    contractResult?.network === networkHealth?.network &&
    contractResult?.chainId === networkHealth?.chainId &&
    networkHealth?.connected === true
      ? contractResult
      : null;
  const queriedContractState =
    usableContract?.state && typeof usableContract.state === "object"
      ? (usableContract.state as Record<string, unknown>)
      : null;
  const contractAgent =
    queriedContractState?.agent &&
    typeof queriedContractState.agent === "object"
      ? (queriedContractState.agent as Record<string, unknown>)
      : {};
  const contractFlow =
    queriedContractState?.stateflow &&
    typeof queriedContractState.stateflow === "object"
      ? (queriedContractState.stateflow as Record<string, unknown>)
      : {};
  const contractTask =
    queriedContractState?.task && typeof queriedContractState.task === "object"
      ? (queriedContractState.task as Record<string, unknown>)
      : {};
  const contractProof =
    queriedContractState?.proofOfRecovery &&
    typeof queriedContractState.proofOfRecovery === "object"
      ? (queriedContractState.proofOfRecovery as Record<string, unknown>)
      : null;
  const contractReceipt =
    contractProof?.receipt && typeof contractProof.receipt === "object"
      ? (contractProof.receipt as Record<string, unknown>)
      : null;
  const contractBackupActive = queriedContractState
    ? Boolean(
        contractReceipt &&
        contractReceipt.backup_identity === contractFlow.worker_key &&
        String(contractReceipt.epoch_to ?? "") ===
          String(contractAgent.generation ?? ""),
      )
    : undefined;
  const localSource = state?.source === "near-rpc";
  const agent = localSource ? (state.agent ?? {}) : contractAgent;
  const checkpoint = localSource
    ? (state.checkpoint ?? {})
    : contractFlow.head && typeof contractFlow.head === "object"
      ? (contractFlow.head as Record<string, unknown>)
      : {};
  const backup = localSource
    ? (state.backupActivation ?? {})
    : {
        currentWorker: contractFlow.worker_key,
        registeredBackups: contractFlow.backup_keys,
        backupActive: contractBackupActive,
        taskId: contractFlow.task_id,
      };
  const sentinel = localSource
    ? (state.sentinel ?? {})
    : {
        configured: undefined,
        taskPolicyConfigured: queriedContractState
          ? Boolean(contractTask.sentinel)
          : undefined,
        taskApprovalNonce: (
          contractTask.sentinel as Record<string, unknown> | null
        )?.last_nonce,
      };
  const guardian = localSource
    ? (state.guardian ?? {})
    : {
        quarantine: queriedContractState
          ? agent.status === "Contained" || contractTask.paused === true
          : undefined,
        taskPaused: contractTask.paused,
        events: [],
      };
  const escrow = localSource
    ? (state.escrow ?? {})
    : {
        ...contractTask,
        taskId: queriedContractState ? configuredContractIds.taskId : undefined,
        executionEpoch: contractTask.execution_epoch,
        expiresAt: contractTask.expires_at,
      };
  const escrowEvidenceSource =
    state?.source === "near-rpc"
      ? "LOCALNET RPC · CONFIGURED TASK VIEW"
      : usableContract?.verification === "finalized-rpc-observation"
        ? `${String(usableContract.network ?? "UNKNOWN").toUpperCase()} · FINALIZED RPC OBSERVATION`
        : "NO VERIFIED CONTRACT SOURCE";
  const payments = Array.isArray(escrow.payments)
    ? (escrow.payments as Array<Record<string, unknown>>)
    : [];
  const securityEvents =
    guardian.auditVerified === true && Array.isArray(guardian.events)
      ? (guardian.events as Array<Record<string, unknown>>)
      : [];
  const rpcHealthy =
    networkHealth?.connected === true &&
    networkHealth.chainId === networkHealth.network;
  const sandboxKinds = new Set(demo.events.map((event) => event.kind));
  const quarantineCount = securityEvents.filter(
    (event) => event.decision === "Quarantine",
  ).length;
  const paidPaymentCount = payments.filter(
    (payment) =>
      payment.status === "Succeeded" || payment.state === "Succeeded",
  ).length;
  const failedPaymentCount = payments.filter(
    (payment) => payment.status === "Failed" || payment.state === "Failed",
  ).length;
  const verifiedGuardianHistory = guardian.auditVerified === true;
  const evidenceMetrics = deriveEvidenceMetrics(
    demo.events,
    securityEvents,
    verifiedGuardianHistory,
  );
  const proofEnvelope = localSource
    ? (state.proofOfRecovery ?? null)
    : contractProof;
  const recoveryReceipt =
    proofEnvelope?.receipt && typeof proofEnvelope.receipt === "object"
      ? (proofEnvelope.receipt as Record<string, unknown>)
      : null;
  const signedRecoveryReceipt =
    recoveryReceipt?.signed_receipt &&
    typeof recoveryReceipt.signed_receipt === "object"
      ? (recoveryReceipt.signed_receipt as Record<string, unknown>)
      : null;
  const signedRecoveryBody =
    signedRecoveryReceipt?.body &&
    typeof signedRecoveryReceipt.body === "object"
      ? (signedRecoveryReceipt.body as Record<string, unknown>)
      : null;
  const chainTimestampNs =
    typeof state?.chain?.blockTimestampNs === "string"
      ? state.chain.blockTimestampNs
      : null;
  const heartbeatFreshness = (() => {
    if (localSource && backendError) return "stale";
    if (typeof agent.heartbeatStatus === "string") return agent.heartbeatStatus;
    if (agent.status !== "Running") return agent.status ?? "unknown";
    try {
      const heartbeat = BigInt(show(agent.heartbeatAt ?? agent.heartbeat_at));
      const timeout = BigInt(show(agent.timeoutNs ?? agent.timeout_ns));
      const now = BigInt(show(chainTimestampNs));
      return now >= heartbeat && now - heartbeat < timeout ? "live" : "expired";
    } catch {
      return "unknown";
    }
  })();
  const heartbeatAge = (() => {
    try {
      const heartbeatAt = agent.heartbeatAt ?? agent.heartbeat_at;
      if (
        typeof chainTimestampNs !== "string" ||
        typeof heartbeatAt !== "string"
      )
        return null;
      const delta = BigInt(chainTimestampNs) - BigInt(heartbeatAt);
      return delta >= 0n ? (Number(delta) / 1_000_000_000).toFixed(2) : null;
    } catch {
      return null;
    }
  })();
  const demoSteps = [
    ["primary_heartbeat", "Primary heartbeat"],
    ["checkpoint_committed", "Checkpoint committed"],
    ["primary_failed", "Failure detected"],
    ["backup_restored", "Backup restored"],
    ["suspicious_payment_rejected", "Suspicious payment rejected"],
    ["payment_settled", "Settlement finalized"],
    ["duplicate_payment_prevented", "Duplicate prevented"],
    ["guardian_quarantined", "GUARDIAN quarantine"],
  ] as const;

  const hasSource =
    localSource || usableContract?.verification === "finalized-rpc-observation";
  const stale = Boolean(backendError && localSource);
  const sourceLabel = stale
    ? "LOCALNET · STALE SNAPSHOT"
    : escrowEvidenceSource;
  const sourceShort = localSource
    ? "LOCALNET"
    : usableContract
      ? show(usableContract.network).toUpperCase()
      : "NO TELEMETRY";
  const observed =
    localSource && state?.observedAt
      ? new Date(state.observedAt).toLocaleTimeString("en-GB", {
          timeZone: "UTC",
        }) + " UTC"
      : usableContract
        ? `Contract block ${show(usableContract.blockHeight)}`
        : "Awaiting observation";
  const graph = (
    <RecoveryNetwork
      agent={agent}
      checkpoint={checkpoint}
      backup={backup}
      sentinel={sentinel}
      guardian={guardian}
      escrow={escrow}
      proof={proofEnvelope}
      events={demo.events}
      demoStatus={demo.status}
      source={sourceLabel}
      heartbeat={show(heartbeatFreshness)}
      stale={stale}
    />
  );
  const receipt = (
    <Card title="PROOF OF RECOVERY" accent="purple">
      <div className="panel-heading">
        <div>
          <h2>A recovery. A record.</h2>
          <p>Identity, checkpoint and settlement bound to one epoch.</p>
        </div>
        <span className="status-chip neutral">
          {recoveryReceipt ? "RPC OBSERVATION" : "AWAITING EVIDENCE"}
        </span>
      </div>
      {recoveryReceipt ? (
        <>
          <div className="field-grid">
            <Field label="Recovery epoch" value={recoveryReceipt.epoch_to} />
            <Field
              label="Backup identity"
              value={recoveryReceipt.backup_identity}
            />
            <Field
              label="Checkpoint digest"
              value={recoveryReceipt.checkpoint_hash}
            />
            <Field
              label="Settlement operation"
              value={signedRecoveryBody?.settlement_reference}
            />
            <Field
              label="Receipt evidence"
              value={
                signedRecoveryReceipt
                  ? "Signed receipt stored"
                  : "No signed receipt"
              }
            />
            <Field
              label="SENTINEL verifier"
              value={recoveryReceipt.verified_by}
            />
            <Field
              label="Settlement block reference"
              value={signedRecoveryBody?.settlement_block_height}
            />
            <Field
              label="Snapshot block"
              value={
                localSource
                  ? state?.chain?.blockHeight
                  : usableContract?.blockHeight
              }
            />
          </div>
          <details className="evidence-disclosure">
            <summary>Inspect cryptographic evidence</summary>
            <pre>{JSON.stringify(recoveryReceipt, null, 2)}</pre>
          </details>
        </>
      ) : (
        <div className="empty-state">
          <Icon name="shield" />
          <h3>No receipt at this observation</h3>
          <p>
            {proofEnvelope?.status === "no-receipt-at-current-epoch"
              ? `No receipt recorded at epoch ${show(proofEnvelope.currentEpoch)}.`
              : "Connect a configured contract source to inspect recovery evidence."}
          </p>
        </div>
      )}
      <p className="evidence-footnote">
        {sourceLabel} · Signed observer evidence and RPC observations are
        distinct from independently verified proofs. This dashboard does not
        independently verify receipt cryptography.
      </p>
    </Card>
  );
  const ledger = (
    <Card title="TASK ESCROW · REWIND" accent="cyan">
      <div className="panel-heading">
        <div>
          <h2>Every settlement, accounted for.</h2>
          <p>Native NEAR · exact integer amounts in yoctoNEAR</p>
        </div>
        <span className="status-chip neutral">{sourceShort}</span>
      </div>
      <div className="escrow-balances">
        {[
          ["Available", escrow.available],
          ["Reserved", escrow.reserved],
          ["Pending", escrow.pending],
          ["Finalized paid", escrow.paid],
          ["Refunded", escrow.refunded],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <span>{String(label)}</span>
            <strong>{show(value)}</strong>
            <small>yoctoNEAR</small>
          </div>
        ))}
      </div>
      <div className="field-grid">
        <Field label="Task ID" value={escrow.taskId} />
        <Field label="Funding" value={escrow.funded} />
        <Field label="Execution epoch" value={escrow.executionEpoch} />
        <Field label="Task paused" value={guardian.taskPaused} />
      </div>
      <div className="table-scroll">
        <table>
          <caption>Returned configured operations · {sourceLabel}</caption>
          <thead>
            <tr>
              <th>Operation</th>
              <th>Kind</th>
              <th>Recipient</th>
              <th>Amount (yoctoNEAR)</th>
              <th>Authorization</th>
              <th>Settlement</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p, i) => (
              <motion.tr
                key={show(p.operationId ?? i)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <td>
                  <code>{show(p.operationId)}</code>
                  {typeof p.operationId === "string" && (
                    <CopyButton
                      value={p.operationId}
                      label="Copy operation ID"
                    />
                  )}
                </td>
                <td>{show(p.kind)}</td>
                <td>{show(p.recipient)}</td>
                <td>{show(p.amount)}</td>
                <td>
                  {p.approved === true
                    ? "Approval recorded"
                    : p.approved === false
                      ? "Not approved"
                      : "Not reported"}
                </td>
                <td>
                  <span
                    className={`status-chip ${p.state === "Succeeded" ? "good" : p.state === "Failed" ? "danger" : p.state === "Pending" || p.state === "Uncertain" ? "warning" : "neutral"}`}
                  >
                    {show(p.state)}
                  </span>
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
      {!payments.length && (
        <div className="empty-state">
          <Icon name="layers" />
          <h3>No payment operations returned</h3>
          <p>
            Configure operation IDs to inspect authorization and callback
            outcomes.
          </p>
        </div>
      )}
      <p className="evidence-footnote">
        Pending and uncertain transfers remain unsettled. A successful refund is
        not a payment. Operation IDs are not transaction hashes.
      </p>
      <button className="text-button" onClick={() => navigate("explorer")}>
        Verify a transaction in Blockchain Explorer ↗
      </button>
    </Card>
  );
  const securityView = (
    <section
      id="security"
      className="section-block"
      aria-labelledby="security-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">SECURITY OPERATIONS</p>
          <h2 id="security-heading">Security posture & incident timeline</h2>
        </div>
        <span
          className={`status-chip ${guardian.quarantine === true ? "danger" : "neutral"}`}
        >
          {guardian.quarantine
            ? "QUARANTINE ACTIVE"
            : guardian.quarantine === false && !backendError
              ? "NO QUARANTINE REPORTED"
              : "POSTURE UNKNOWN"}
        </span>
      </div>
      <div className="security-layout">
        <Card title="GUARDIAN STATUS" accent="amber">
          <Field label="Agent quarantined" value={guardian.quarantine} />
          <Field label="Task paused" value={guardian.taskPaused} />
          <Field label="Audit anchor" value={guardian.auditHead} />
          <Field
            label="Anchored incidents"
            value={verifiedGuardianHistory ? securityEvents.length : undefined}
          />
          <Field
            label="Quarantine decisions"
            value={verifiedGuardianHistory ? quarantineCount : undefined}
          />
          <p className="muted">
            Off-chain observer evidence may trigger a fail-safe pause. It cannot
            authorize recovery or funds.
          </p>
        </Card>
        <div className="incident-panel">
          <div className="panel-heading">
            <h3>Audit-anchored events</h3>
            <span>
              {verifiedGuardianHistory
                ? `${securityEvents.length} verified records`
                : "History unavailable"}
            </span>
          </div>
          {verifiedGuardianHistory && securityEvents.length ? (
            <ol className="incident-timeline">
              {[...securityEvents].reverse().map((event, i) => (
                <li key={`${show(event.sequence)}-${i}`}>
                  <span
                    className={`incident-marker ${event.decision === "Quarantine" ? "alert" : ""}`}
                    aria-hidden="true"
                  />
                  <EvidenceDisclosure
                    title={show(event.kind)}
                    subtitle={`#${show(event.sequence)} · epoch ${show(event.epoch)} · ${show(event.decision)}${event.reason ? `: ${show(event.reason)}` : ""}`}
                  >
                    <div className="incident-details">
                      <p>
                        Evidence ID <code>{show(event.evidenceId)}</code>
                      </p>
                      <p>
                        Observer <code>{show(event.sourceKey)}</code>
                      </p>
                      <p>
                        Chain time (ns) <code>{show(event.observedAtNs)}</code>
                      </p>
                      {event.details !== null &&
                        typeof event.details === "object" && (
                          <pre>{JSON.stringify(event.details, null, 2)}</pre>
                        )}
                    </div>
                  </EvidenceDisclosure>
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty-state">
              {verifiedGuardianHistory
                ? "No incident records are available at the verified audit head."
                : "Waiting for chain-anchored GUARDIAN telemetry."}
            </div>
          )}
        </div>
      </div>
      <div className="three-grid">
        <Card title="RISK ASSESSMENT">
          <div className="unavailable-value">Not reported</div>
          <p>
            No numeric risk assessment is exposed by the current API. Absence of
            incidents does not establish safety.
          </p>
        </Card>
        <Card title="POLICY THRESHOLDS">
          <div className="unavailable-value">Not exposed</div>
          <p>
            Observer keys, rate limits and risk thresholds are configured by the
            monitor. Their active values are not exposed here.
          </p>
        </Card>
        <Card title="REJECTED AUTHORIZATIONS">
          <div className="stat-value">
            {evidenceMetrics.authorizationFailures ?? "—"}
          </div>
          <p>
            {verifiedGuardianHistory
              ? "Matching events in returned, verified audit history."
              : "Requires verified, anchored GUARDIAN evidence."}
          </p>
        </Card>
      </div>
    </section>
  );
  const explorerView = (
    <section
      id="explorer"
      className="section-block"
      aria-labelledby="explorer-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">BLOCKCHAIN EXPLORER</p>
          <h2 id="explorer-heading">Inspect finalized NEAR state</h2>
        </div>
        <span className="source-label">NO SIGNING · NO SUBMISSION</span>
      </div>
      <section className="card network-card">
        <div className="network-summary">
          <div>
            <h3>Network health</h3>
            <p>
              Network is marked healthy only when the configured RPC responds
              and its chain ID matches the selected network.
            </p>
          </div>
          <span className={`status-chip ${rpcHealthy ? "good" : "neutral"}`}>
            {rpcHealthy
              ? `${show(networkHealth?.network).toUpperCase()} VERIFIED`
              : "NOT VERIFIED"}
          </span>
        </div>
        {networkHealth && (
          <div className="field-grid">
            <Field label="RPC chain ID" value={networkHealth.chainId} />
            <Field label="Network" value={networkHealth.network} />
            <Field
              label="Latest RPC head height"
              value={networkHealth.latestBlockHeight}
            />
            <Field
              label="Latest RPC head hash"
              value={networkHealth.latestBlockHash}
            />
          </div>
        )}
        {networkError && (
          <div className="notice danger" role="alert">
            RPC health check failed: {networkError}
          </div>
        )}
        <div className="network-tools">
          <form onSubmit={lookupAccount}>
            <h3>Account information</h3>
            <label>
              NEAR account ID
              <input
                value={accountInput}
                onChange={(event) => setAccountInput(event.target.value)}
                placeholder="account.near"
                autoComplete="off"
              />
            </label>
            <button type="submit" disabled={accountLoading}>
              {accountLoading ? "Reading…" : "Read account"}
            </button>
            {accountError && (
              <p className="notice danger" role="alert">
                {accountError}
              </p>
            )}
            {accountResult && (
              <pre>{JSON.stringify(accountResult, null, 2)}</pre>
            )}
          </form>
          <form onSubmit={lookupTransaction}>
            <h3>Transaction lookup</h3>
            <label>
              Transaction hash
              <input
                value={txHash}
                onChange={(event) => setTxHash(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              Signer account
              <input
                value={txSender}
                onChange={(event) => setTxSender(event.target.value)}
                placeholder="account.near"
                autoComplete="off"
              />
            </label>
            <button type="submit" disabled={!rpcHealthy || txLoading}>
              {txLoading ? "Checking RPC…" : "Verify with selected RPC"}
            </button>
            {txError && (
              <p className="notice danger" role="alert">
                {txError}
              </p>
            )}
            {txResult && (
              <>
                <pre>{JSON.stringify(txResult, null, 2)}</pre>
                {typeof txResult.explorerUrl === "string" &&
                  txResult.verifiedBy === "selected-near-rpc" &&
                  txResult.network === networkHealth?.network &&
                  txResult.chainId === networkHealth?.chainId && (
                    <a
                      href={txResult.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open RPC-confirmed transaction in {show(txResult.network)}{" "}
                      explorer
                    </a>
                  )}
                <p className="muted">
                  RPC identity match is not an independent cryptographic proof.
                  Sandbox demo events never receive explorer links.
                </p>
              </>
            )}
          </form>
        </div>
        <div className="network-tools">
          <div>
            <h3>Contract state</h3>
            <p>Reads code hashes and views at a pinned finalized block.</p>
            <button
              onClick={lookupContracts}
              disabled={
                !rpcHealthy ||
                contractLoading ||
                Object.values(configuredContractIds).some((value) => !value)
              }
            >
              {contractLoading
                ? "Reading finalized state…"
                : "Read configured contract state"}
            </button>
            {Object.values(configuredContractIds).some((value) => !value) && (
              <p className="muted">
                Set public Core, REWIND, agent and task IDs to enable contract
                views.
              </p>
            )}
            {contractError && (
              <p className="notice danger" role="alert">
                {contractError}
              </p>
            )}
            {contractResult && (
              <pre>{JSON.stringify(contractResult, null, 2)}</pre>
            )}
          </div>
        </div>
      </section>
    </section>
  );
  const developersView = (
    <section
      id="developers"
      className="section-block"
      aria-labelledby="developers-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">DEVELOPER CONSOLE</p>
          <h2 id="developers-heading">Wallet & transaction workspace</h2>
        </div>
        <span className="source-label">VERIFY · REVIEW · AUTHORIZE</span>
      </div>
      <TransactionWorkbench api={API} session={walletSession} health={networkHealth} getConnector={() => walletRuntimeRef.current?.connector ?? null} onConnect={() => void connectWallet()} />
      <div className="two-grid">
        <Card title="WALLET SESSION" accent="cyan">
          <p>
            NEAR Connect isolates wallet integrations. The wallet and verified RPC must agree on network. Connecting establishes a session; every operator action has a separate review.
          </p>
          <div className="wallet-controls">
            {walletSession.status === "connected" &&
            walletNetworkMatches(networkHealth, walletSession.network ?? "") ? (
              <>
                <span className="wallet-account">
                  {walletSession.accountId}
                </span>
                <span className="tag">
                  {walletSession.network?.toUpperCase()}
                </span>
                <button
                  type="button"
                  onClick={() => void disconnectWallet()}
                  disabled={walletBusy}
                >
                  {walletBusy ? "Disconnecting…" : "Disconnect Wallet"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={connectWallet}
                disabled={
                  !walletReady ||
                  walletBusy ||
                  !walletNetworkMatches(
                    networkHealth,
                    networkHealth?.network ?? "",
                  )
                }
              >
                {walletBusy ? "Waiting for wallet…" : "Connect Wallet"}
              </button>
            )}
          </div>
          {walletSession.status === "connected" && walletAccountInfo && (
            <p className="muted">
              RPC balance: {show(walletAccountInfo.amount)} yoctoNEAR ·
              finalized block {show(walletAccountInfo.blockHeight)}
              {walletAccountInfo.error
                ? ` · ${show(walletAccountInfo.error)}`
                : ""}
            </p>
          )}
          {networkHealth?.network === "localnet" && (
            <p className="muted">
              Wallet connection is disabled on localnet. Use the sandbox
              walkthrough.
            </p>
          )}
          {walletSession.error && (
            <p className="notice danger" role="alert">
              {walletSession.error}
            </p>
          )}
          {walletSession.status === "connected" &&
            !walletNetworkMatches(
              networkHealth,
              walletSession.network ?? "",
            ) && (
              <p className="notice danger" role="alert">
                Wallet and RPC networks differ; account state was cleared.
              </p>
            )}
        </Card>
        <Card title="READ-ONLY NETWORK BOUNDARY" accent="purple">
          <p>
            Public observations remain read-only. Operator actions are prepared by policy and submitted only through your wallet after review. The server holds no signing keys.
          </p>
          <Field label="Selected network" value={networkHealth?.network} />
          <Field
            label="RPC connection"
            value={rpcHealthy ? "Verified" : "Unknown"}
          />
          <Field label="Wallet session" value={walletSession.status} />
        </Card>
      </div>
      <details className="preflight">
        <summary>Mainnet deployment preflight · read-only</summary>
        <p>
          Checks public account identifiers, access-key permissions and expected
          code hashes. It never creates or submits transactions.
        </p>
        <form onSubmit={runPreflight} className="preflight-form">
          <div className="field-grid">
            {(
              [
                ["accountId", "Deployment account ID"],
                ["publicKey", "Public ed25519 access key"],
                ["coreContractId", "PHOENIX Core target account"],
                ["vaultContractId", "REWIND target account"],
                ["expectedCoreCodeHash", "Expected Core WASM code hash"],
                ["expectedVaultCodeHash", "Expected REWIND WASM code hash"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={preflightFields[key]}
                  onChange={(event) =>
                    setPreflightFields((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </label>
            ))}
          </div>
          <button
            type="submit"
            disabled={networkHealth?.chainId !== "mainnet" || preflightLoading}
          >
            {preflightLoading
              ? "Checking read-only state…"
              : "Run read-only checks"}
          </button>
        </form>
        {preflightError && (
          <p className="notice danger" role="alert">
            {preflightError}
          </p>
        )}
        {preflight && <pre>{JSON.stringify(preflight, null, 2)}</pre>}
      </details>
    </section>
  );
  const analyticsView = (
    <section
      id="analytics"
      className="section-block"
      aria-labelledby="analytics-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">ANALYTICS</p>
          <h2 id="analytics-heading">Signals from observed state</h2>
        </div>
        <span className="source-label">NO SYNTHETIC METRICS</span>
      </div>
      <div className="analytics-grid">
        <article className="analytics-card">
          <span>RECOVERY LATENCY</span>
          <strong>
            {evidenceMetrics.recoveryLatency === null
              ? "Unavailable"
              : `${evidenceMetrics.recoveryLatency}s`}
          </strong>
          <small>
            {evidenceMetrics.recoveryLatency === null
              ? "Requires an observed failure and later restoration pair in the current sandbox run."
              : "One observed sandbox failure-to-restoration interval; not a production SLO."}
          </small>
        </article>
        <article className="analytics-card">
          <span>RECOVERY SUCCESS RATE</span>
          <strong>Unavailable</strong>
          <small>
            No complete history of recovery attempts and outcomes is exposed; a
            latest successful receipt is not a denominator.
          </small>
        </article>
        <article className="analytics-card">
          <span>DUPLICATE PAYMENTS PREVENTED</span>
          <strong>
            {evidenceMetrics.duplicatePreventions === null
              ? "Unavailable"
              : evidenceMetrics.duplicatePreventions}
          </strong>
          <small>
            {evidenceMetrics.duplicatePreventions === null
              ? "No local demo event history returned."
              : "Observed duplicate-prevention events in this local sandbox demo run only."}
          </small>
        </article>
        <article className="analytics-card">
          <span>AUTHORIZATION FAILURES</span>
          <strong>
            {evidenceMetrics.authorizationFailures === null
              ? "Unavailable"
              : evidenceMetrics.authorizationFailures}
          </strong>
          <small>
            {evidenceMetrics.authorizationFailures === null
              ? "Verified anchored GUARDIAN history is unavailable."
              : "Matching rejection events in returned verified audit history; bounded to this history."}
          </small>
        </article>
        <article className="analytics-card">
          <span>SECURITY INCIDENTS</span>
          <strong>
            {evidenceMetrics.incidents === null
              ? "Unavailable"
              : evidenceMetrics.incidents}
          </strong>
          <small>
            {evidenceMetrics.incidents === null
              ? "Verified anchored GUARDIAN history is unavailable."
              : "Quarantine decisions in returned verified audit history; not a global incident count."}
          </small>
        </article>
        <article className="analytics-card">
          <span>RECOVERY EPOCH</span>
          <strong>{show(agent.generation)}</strong>
          <small>
            Current generation · source: configured finalized Core view
          </small>
        </article>
        <article className="analytics-card">
          <span>OBSERVED PAYMENT OPERATIONS</span>
          <strong>
            {Array.isArray(escrow.payments) ? payments.length : "Unavailable"}
          </strong>
          <small>
            {paidPaymentCount} succeeded · {failedPaymentCount} failed in
            configured operation lookups
          </small>
        </article>
        <article className="analytics-card">
          <span>BACKUP ACTIVITY</span>
          <strong>{show(backup.backupActive)}</strong>
          <small>
            Worker identity and epoch matched against the current recovery
            receipt
          </small>
        </article>
      </div>
      <div className="analytics-note">
        Recovery latency and duplicate prevention are per-run local sandbox
        observations. Authorization and incident counts use only the returned
        audit range after its head is verified. Missing, incomplete or
        unverified data is shown as unavailable. These metrics are descriptive
        only; they do not authorize actions.
      </div>
      <EvidenceChart
        events={demo.events}
        payments={payments}
        source={sourceLabel}
      />
      <div className="analytics-note">
        <strong>Agent availability · Unavailable.</strong> A historical
        heartbeat denominator is not exposed. Incident frequency also requires
        an observation window; current counts are not rates.
      </div>
    </section>
  );
  const token_economicsView = (
    <section
      id="token-economics"
      className="section-block"
      aria-labelledby="economics-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">TOKEN ECONOMICS</p>
          <h2 id="economics-heading">Native NEAR, task-scoped accounting</h2>
        </div>
        <span className="source-label">
          IMPLEMENTED MECHANISM + CLEARLY MARKED PROPOSALS
        </span>
      </div>
      <div className="economics-card">
        <p className="muted">
          NEAR is the only on-chain denomination used by this prototype.
          Transaction execution consumes network gas; REWIND accepts task
          funding in native NEAR and reports integer yoctoNEAR. No protocol
          token, price, supply, fee rate, reward schedule or revenue stream is
          configured.
        </p>
        <p className="source-label">ESCROW SOURCE · {sourceLabel}</p>
        <div className="economics-grid">
          <Field label="Task" value={escrow.taskId} />
          <Field label="Funded" value={escrow.funded} />
          <Field label="Available" value={escrow.available} />
          <Field label="Reserved" value={escrow.reserved} />
          <Field label="Pending" value={escrow.pending} />
          <Field label="Paid" value={escrow.paid} />
          <Field label="Refunded" value={escrow.refunded} />
          <Field label="Execution epoch" value={escrow.executionEpoch} />
        </div>
        <div className="ledger-heading">
          <h3>REWIND payment operations</h3>
          <span>SENTINEL APPROVAL STATE</span>
        </div>
        {payments.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Kind / recipient</th>
                  <th scope="col">Amount (yoctoNEAR)</th>
                  <th scope="col">Approval</th>
                  <th scope="col">Settlement</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment, index) => (
                  <tr key={String(payment.operationId ?? index)}>
                    <td>
                      <code>{show(payment.operationId)}</code>
                    </td>
                    <td>
                      {show(payment.kind)} ·{" "}
                      <code>{show(payment.recipient)}</code>
                    </td>
                    <td>{show(payment.amount)}</td>
                    <td>
                      <span
                        className={`status-chip ${payment.approved === true ? "good" : "neutral"}`}
                      >
                        {payment.approved === true
                          ? "Approval recorded"
                          : payment.approved === false
                            ? "Not approved"
                            : "Not reported"}
                      </span>
                    </td>
                    <td>{show(payment.state)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            No operation IDs are configured for this task, or no matching
            operations were returned. Approval is not inferred from an empty
            list.
          </div>
        )}
        <div className="method-grid economics-context">
          <article>
            <span className="method-index">IMPLEMENTED</span>
            <h3>Implemented utility</h3>
            <p>
              NEAR pays network execution costs and provides the task escrow
              denomination. REWIND tracks funded, reserved, pending, paid and
              refunded balances; contract rules constrain recipients, budgets,
              approvals and settlement outcomes. A separate storage bond is
              required by the contract.
            </p>
          </article>
          <article>
            <span className="method-index">PROPOSAL</span>
            <h3>Potential operator incentives</h3>
            <p>
              A future task policy could compensate a backup operator in NEAR
              after verifiable restoration and an explicitly authorized REWIND
              settlement. This release has no automatic compensation schedule,
              reward pool or token emission. Proofs provide evidence; they do
              not create a payment entitlement by themselves.
            </p>
          </article>
          <article>
            <span className="method-index">PROPOSAL</span>
            <h3>Fees and sustainability</h3>
            <p>
              No protocol fee or revenue model is implemented. Any future fee
              needs explicit governance, disclosed caps and recipient, opt-in
              task terms, independent approval and contract enforcement.
              Sustainability depends on real operating costs and adoption; no
              forecast is asserted.
            </p>
          </article>
          <article>
            <span className="method-index">RISK</span>
            <h3>Economic risks</h3>
            <p>
              Potential risks include NEAR price and gas volatility, locked or
              stranded escrow during uncertain outcomes, underfunded backup
              operations, incentive gaming or Sybil identities, compensation
              disputes and fee designs that reduce participation.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
  const methodologyView = (
    <section
      id="methodology"
      className="section-block"
      aria-labelledby="methodology-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">METHODOLOGY & DATA</p>
          <h2 id="methodology-heading">Evidence, method and limits</h2>
        </div>
        <span className="source-label">
          PROVENANCE SHOWN · NO INFERRED SUCCESS
        </span>
      </div>
      <MethodFlow />
      <div className="method-grid">
        <article>
          <span className="method-index">01</span>
          <h3>Heartbeat & fault injection</h3>
          <p>
            The coordinator polls heartbeat state; contract expiry is evaluated
            against NEAR block time. Sandbox drills stop the primary worker and
            advance real local chain activity. A process crash is a controlled
            fault injection, not a fleet reliability sample.
          </p>
        </article>
        <article>
          <span className="method-index">02</span>
          <h3>Checkpoint & backup selection</h3>
          <p>
            Signed task-domain checkpoints are verified for signer, digest,
            sequence and fencing context. Backup candidates come from the
            authorized set and deterministic selection/lease rules; competing
            and stale-epoch claims are rejected.
          </p>
        </article>
        <article>
          <span className="method-index">03</span>
          <h3>Recovery authorization</h3>
          <p>
            Recovery requires the contract authorization path and a fresh
            independent SENTINEL approval bound to task, action, checkpoint,
            epoch and nonce. GUARDIAN quarantine is checked as a separate stop
            condition; risk signals cannot grant authority.
          </p>
        </article>
        <article>
          <span className="method-index">04</span>
          <h3>Settlement & receipt</h3>
          <p>
            REWIND validates task budget, approved recipient, one-time payment
            ID, epoch and approval. Its asynchronous callback determines final
            transfer state. A Proof-of-Recovery binds the recorded transition
            and supplied successful settlement evidence; observer-sourced
            evidence remains trusted input.
          </p>
        </article>
        <article>
          <span className="method-index">05</span>
          <h3>Data provenance</h3>
          <p>
            Contract panels use finalized RPC view results; transaction links
            require an RPC lookup matching the selected network. GUARDIAN
            entries are shown only when the signed audit bytes match the
            configured chain anchor. Local drill events come from the backend
            child-process stream and are labeled sandbox.
          </p>
        </article>
        <article>
          <span className="method-index">06</span>
          <h3>Analytics scope</h3>
          <p>
            Latency is a timestamp difference for an observed
            failure/restoration pair in the current drill. Duplicate prevention
            counts returned demo events only. Security counts cover only
            returned verified audit history. Success rate is unavailable until a
            complete attempt denominator and outcome history exist.
          </p>
        </article>
      </div>
      <div className="analytics-note">
        <strong>Reproduce locally:</strong>{" "}
        <code>cargo test --workspace --locked</code> ·{" "}
        <code>
          cargo test --manifest-path services/recovery/Cargo.toml --locked
        </code>{" "}
        ·{" "}
        <code>
          cargo test --manifest-path integration-tests/Cargo.toml --locked --
          --nocapture
        </code>{" "}
        · <code>npm test -w @phoenix/backend</code> ·{" "}
        <code>npm run test:wallet -w @phoenix/dashboard</code> ·{" "}
        <code>npm run typecheck</code> ·{" "}
        <code>npm run build -w @phoenix/dashboard</code>. Sandbox output is not
        mainnet evidence.
      </div>
    </section>
  );
  const aboutView = (
    <section
      id="about"
      className="section-block about-section"
      aria-labelledby="about-heading"
    >
      <div>
        <p className="eyebrow">ABOUT PHOENIX</p>
        <h2 id="about-heading">Resilience with deterministic boundaries.</h2>
        <p>
          PHOENIX coordinates agent recovery. STATEFLOW commits checkpoints.
          SENTINEL independently authorizes high-risk actions. REWIND enforces
          escrow rules. GUARDIAN reports security signals and supports scoped
          containment.
        </p>
      </div>
      <div className="about-stamp">
        <span>PHOENIX</span>
        <small>MISSION CONTROL · v5.0</small>
        <small>LOCAL CONTROL PLANE</small>
      </div>
    </section>
  );
  const demoView = (
    <section
      id="demo"
      className="section-block demo-section"
      aria-labelledby="demo-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">INTERACTIVE SANDBOX WALKTHROUGH</p>
          <h2 id="demo-heading">Failure, restoration, integrity</h2>
          <p className="section-intro">
            Runs the local worker and sandbox assertions. Progress below is
            derived from actual backend events.
          </p>
        </div>
        <MagneticButton
          onClick={() => void startDemo()}
          disabled={starting || demo.status === "running"}
        >
          {starting
            ? "Starting…"
            : demo.status === "running"
              ? "Walkthrough running"
              : "Start walkthrough"}
        </MagneticButton>
      </div>
      <div
        className={`demo-status ${demo.status}`}
        role="status"
        aria-live="polite"
      >
        <span className="led" />
        {demo.status === "succeeded"
          ? "Complete · backend sandbox assertions passed"
          : demo.status === "failed"
            ? "Failed · see backend error and observed evidence"
            : demo.status === "running"
              ? "Running · awaiting worker and sandbox events"
              : "Ready · no demonstration has run"}
      </div>
      {demo.error && (
        <div className="notice danger" role="alert">
          {demo.error}
        </div>
      )}
      <ol className="walkthrough-steps">
        {demoSteps.map(([kind, label], index) => (
          <li
            key={kind}
            className={sandboxKinds.has(kind) ? "observed" : "pending"}
          >
            <span>
              {sandboxKinds.has(kind)
                ? "✓"
                : String(index + 1).padStart(2, "0")}
            </span>
            {label}
            <small>
              {sandboxKinds.has(kind) ? "Observed" : "Awaiting evidence"}
            </small>
          </li>
        ))}
      </ol>
      <div
        className="demo-timeline"
        aria-label="Observed sandbox event timeline"
      >
        {demo.events.length ? (
          demo.events.map((event) => (
            <article key={event.id} className="demo-event">
              <span className="event-index">
                {String(event.id).padStart(2, "0")}
              </span>
              <div>
                <b>{event.kind.replaceAll("_", " ")}</b>
                <p>
                  {Object.entries(event.details)
                    .map(([key, value]) => `${key}: ${show(value)}`)
                    .join(" · ")}
                </p>
                <time dateTime={event.at}>
                  {new Date(event.at).toLocaleTimeString()}
                </time>
              </div>
              <span className="event-environment">LOCAL SANDBOX</span>
            </article>
          ))
        ) : (
          <div className="empty-state">
            {demo.status === "running"
              ? "Waiting for the first event from the local worker and sandbox…"
              : "No drill evidence yet. Start the walkthrough to populate this timeline from real backend events."}
          </div>
        )}
      </div>
    </section>
  );

  const titles: Record<string, [string, string]> = {
    overview: [
      "Your autonomous operations. In focus.",
      "A clear view of recovery, security and accountable execution.",
    ],
    recovery: [
      "Resilience, made visible.",
      "Follow each trust boundary from failure to recovery evidence.",
    ],
    security: [
      "Security has a chain of evidence.",
      "GUARDIAN · containment, signed observations and incident response.",
    ],
    escrow: [
      "Payments with explicit boundaries.",
      "REWIND · task budgets, authorization and finalized settlement.",
    ],
    sentinel: [
      "Trust is an explicit decision.",
      "SENTINEL · independently scoped authorization and recovery receipts.",
    ],
    explorer: [
      "Read the chain. Follow the evidence.",
      "Public NEAR observations with verified network identity.",
    ],
    analytics: [
      "Measured. Never imagined.",
      "Evidence-scoped signals from the data actually available.",
    ],
    "token-economics": [
      "Native utility. Clear economics.",
      "NEAR powers execution and task-specific escrow.",
    ],
    methodology: [
      "Understand every trust boundary.",
      "Reproducible methods, explicit provenance and known limitations.",
    ],
    developers: [
      "Built to be inspected.",
      "Verified network tools, wallet review and reproducible validation.",
    ],
    about: [
      "Continuity for autonomous work.",
      "PHOENIX v5.0 · a local-first recovery protocol for AI agents.",
    ],
  };
  return (
    <MotionProvider>
      <CommandShell
        active={active}
        onNavigate={navigate}
        networkLabel={
          networkHealth?.network?.toUpperCase() ?? "NETWORK UNKNOWN"
        }
        rpcHealthy={rpcHealthy}
        notificationCount={verifiedGuardianHistory ? quarantineCount : 0}
        walletLabel={
          walletBusy
            ? "Connecting…"
            : walletSession.status === "connected"
              ? (walletSession.accountId ?? "Connected")
              : "Connect wallet"
        }
        onWallet={() =>
          walletSession.status === "connected"
            ? navigate("developers")
            : connectWallet()
        }
        walletDisabled={
          walletBusy ||
          (walletSession.status !== "connected" &&
            (!walletReady || !rpcHealthy))
        }
      >
        <div
          className="workspace-content"
          ref={viewRef}
          tabIndex={-1}
          id="main-content"
        >
          {active !== "overview" && <><div className="workspace-heading">
            <motion.div
              key={`hero-${active}`}
              initial={
                reduceMotion
                  ? false
                  : { opacity: 0, y: 16, filter: "blur(5px)" }
              }
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{
                duration: reduceMotion ? 0 : 0.52,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <motion.p
                className="eyebrow"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.35,
                  delay: reduceMotion ? 0 : 0.05,
                }}
              >
                <span className="eyebrow-line" /> PHOENIX COMMAND CENTER{" "}
                <span className="version-tag">V5.0</span>
              </motion.p>
              <motion.h1
                initial={reduceMotion ? false : { opacity: 0, y: 11 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.42,
                  delay: reduceMotion ? 0 : 0.12,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                {titles[active]?.[0]}
              </motion.h1>
              <motion.p
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.38,
                  delay: reduceMotion ? 0 : 0.2,
                }}
              >
                {titles[active]?.[1]}
              </motion.p>
            </motion.div>
            <div className="heading-actions">
              <button
                className="button button-secondary icon-text"
                onClick={async () => {
                  setRefreshing(true);
                  try {
                    await refresh();
                  } finally {
                    setRefreshing(false);
                  }
                }}
                disabled={refreshing}
                aria-label="Refresh telemetry"
              >
                <Icon name="refresh" />
                {refreshing ? "Refreshing" : "Refresh"}
              </button>
              <MagneticButton
                onClick={() => {
                  navigate("recovery");
                  void startDemo();
                }}
                disabled={starting || demo.status === "running"}
              >
                <Icon name="play" />
                {demo.status === "running"
                  ? "Drill running"
                  : "Run sandbox drill"}
              </MagneticButton>
            </div>
          </div>
          <div className="provenance-strip">
            <span>
              <span
                className={`status-dot ${hasSource && !stale ? "good" : "neutral"}`}
              />
              {sourceShort} <span className="provenance-divider">/</span>{" "}
              {stale
                ? "Last snapshot · stale"
                : hasSource
                  ? "Finalized contract observation"
                  : "Awaiting configured contract source"}
            </span>
            <span>
              <Icon name="clock" />
              {observed}
            </span>
          </div>
          {backendError && (
            <div className="notice warning" role="status">
              <Icon name="alert" />
              <span>
                <b>Control Plane unavailable.</b> {backendError} · Start{" "}
                <code>npm run dev:api</code>.{" "}
                {state
                  ? "Displayed local snapshot is stale."
                  : "Live metrics will appear when telemetry is available."}
              </span>
            </div>
          )}
          {!backendError && state?.error && (
            <div className="notice neutral">
              <Icon name="info" />
              <span>
                <b>Awaiting telemetry configuration.</b> {state.error}
              </span>
              <button
                className="text-button"
                onClick={() => navigate("developers")}
              >
                Open console ↗
              </button>
            </div>
          )}
          </>}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
            >
              {active === "overview" && (
                <>
                  <MonolithOverview agent={agent} checkpoint={checkpoint} sentinel={sentinel} escrow={escrow} backup={backup} hasSource={hasSource} stale={stale} source={sourceLabel} observed={observed} sourceError={backendError || state?.error || ""} onNavigate={navigate} onRefresh={refresh}>
                  <div className="metric-grid" id="overview-signals">
                    {[
                      {
                        label: "AGENT LIVENESS",
                        value: hasSource
                          ? show(heartbeatFreshness)
                          : "Awaiting data",
                        note:
                          heartbeatAge === null
                            ? "Chain-time heartbeat observation"
                            : `${heartbeatAge}s since heartbeat · snapshot time`,
                        icon: "activity",
                        accent: "cyan",
                      },
                      {
                        label: "RECOVERY EPOCH",
                        value: agent.generation,
                        note: "Monotonic fencing generation",
                        icon: "recovery",
                        accent: "blue",
                      },
                      {
                        label: "CHECKPOINT HEAD",
                        value: checkpoint.sequence,
                        note:
                          typeof checkpoint.digest === "string"
                            ? `${checkpoint.digest.slice(0, 20)}…`
                            : "Signed STATEFLOW commitment",
                        icon: "layers",
                        accent: "violet",
                      },
                      {
                        label: "ESCROW AVAILABLE",
                        value: escrow.available,
                        note: `yoctoNEAR · ${sourceShort.toLowerCase()}`,
                        icon: "wallet",
                        accent: "cyan",
                      },
                    ].map((item, index) => (
                      <Reveal key={item.label} delay={index * 0.06}>
                        <article
                          className="metric-card"
                          data-accent={item.accent}
                        >
                          <div className="metric-top">
                            <span>{item.label}</span>
                            <Icon name={item.icon} />
                          </div>
                          {!polled ? (
                            <div
                              className="skeleton metric-skeleton"
                              aria-label="Loading metric"
                            />
                          ) : (
                            <strong
                              className={
                                item.value === "live"
                                  ? "tone-good"
                                  : item.value === "expired"
                                    ? "tone-bad"
                                    : ""
                              }
                            >
                              {typeof item.value === "number" &&
                              Number.isSafeInteger(item.value) ? (
                                <AnimatedNumber value={item.value} />
                              ) : item.value === undefined ||
                                item.value === null ? (
                                "—"
                              ) : (
                                String(item.value)
                              )}
                            </strong>
                          )}
                          <small>{item.note}</small>
                        </article>
                      </Reveal>
                    ))}
                  </div>
                  <Reveal delay={0.12}>{graph}</Reveal>
                  <div className="three-grid overview-bottom">
                    <Card title="GUARDIAN · SECURITY" accent="cyan" interactive>
                      <div className="overview-card-icon">
                        <Icon name="shield" />
                        <span
                          className={`status-chip ${guardian.quarantine === true ? "danger" : "neutral"}`}
                        >
                          {guardian.quarantine === true
                            ? "QUARANTINED"
                            : hasSource && !stale
                              ? "OBSERVED"
                              : "UNKNOWN"}
                        </span>
                      </div>
                      <h2>
                        {guardian.quarantine === true
                          ? "Containment active"
                          : "Evidence before confidence."}
                      </h2>
                      <p>
                        {verifiedGuardianHistory
                          ? `${securityEvents.length} records in verified audit history.`
                          : "A verified audit history is required to assess incident activity."}
                      </p>
                      <button
                        className="text-button"
                        onClick={() => navigate("security")}
                      >
                        Explore security <span>↗</span>
                      </button>
                    </Card>
                    <Card
                      title="SENTINEL · AUTHORIZATION"
                      accent="purple"
                      interactive
                    >
                      <div className="overview-card-icon">
                        <Icon name="fingerprint" />
                        <span className="status-chip neutral">
                          INDEPENDENT POLICY
                        </span>
                      </div>
                      <h2>Scoped. Signed. Single use.</h2>
                      <p>
                        Approvals bind actions to a task, epoch, checkpoint and
                        one-time nonce.
                      </p>
                      <button
                        className="text-button"
                        onClick={() => navigate("sentinel")}
                      >
                        Inspect authorizations <span>↗</span>
                      </button>
                    </Card>
                    <Card title="REWIND · SETTLEMENT" accent="blue" interactive>
                      <div className="overview-card-icon">
                        <Icon name="wallet" />
                        <span className="status-chip neutral">
                          {sourceShort}
                        </span>
                      </div>
                      <h2>Every outcome matters.</h2>
                      <p>
                        {Array.isArray(escrow.payments)
                          ? `${paidPaymentCount} succeeded · ${failedPaymentCount} failed in returned operations.`
                          : "Task escrow and callback outcomes appear with configured contract data."}
                      </p>
                      <button
                        className="text-button"
                        onClick={() => navigate("escrow")}
                      >
                        View task escrow <span>↗</span>
                      </button>
                    </Card>
                  </div>
                  </MonolithOverview>
                </>
              )}
              {active === "recovery" && (
                <>
                  {graph}
                  <div className="two-grid">
                    <Card title="PHOENIX · PRIMARY AGENT">
                      <Field
                        label="Agent identity"
                        value={
                          agent.id ??
                          (hasSource
                            ? configuredContractIds.agentId
                            : undefined)
                        }
                      />
                      <Field label="State" value={agent.status} />
                      <Field label="Heartbeat" value={heartbeatFreshness} />
                      <Field label="Recovery epoch" value={agent.generation} />
                      <Field
                        label="Security revision"
                        value={agent.securityRevision}
                      />
                    </Card>
                    <Card title="STATEFLOW · RECOVERY MESH" accent="purple">
                      <Field label="Task" value={backup.taskId} />
                      <Field
                        label="Active worker"
                        value={backup.currentWorker}
                      />
                      <Field
                        label="Registered backups"
                        value={backup.registeredBackups}
                      />
                      <Field
                        label="Backup active"
                        value={backup.backupActive}
                      />
                      <Field
                        label="Checkpoint digest"
                        value={checkpoint.digest}
                      />
                    </Card>
                  </div>
                  {receipt}
                  {demoView}
                </>
              )}
              {active === "security" && securityView}
              {active === "escrow" && (
                <>
                  {ledger}
                  {receipt}
                </>
              )}
              {active === "sentinel" && (
                <>
                  <div className="two-grid">
                    <Card title="INDEPENDENT AUTHORIZATION" accent="purple">
                      <h2>Policy is the perimeter.</h2>
                      <p>
                        Configuration and consumed nonces do not imply that an
                        active approval exists.
                      </p>
                      <Field
                        label="Core policy configured"
                        value={sentinel.configured}
                      />
                      <Field
                        label="Task policy configured"
                        value={sentinel.taskPolicyConfigured}
                      />
                      <Field
                        label="Core nonce consumed"
                        value={sentinel.approvalsConsumed}
                      />
                      <Field
                        label="Task nonce consumed"
                        value={sentinel.taskApprovalNonce}
                      />
                      <Field
                        label="Active approval record"
                        value="Not exposed by the API"
                      />
                    </Card>
                    <Card title="RECEIPT AUTHORIZATION" accent="cyan">
                      <Field
                        label="Receipt nonce"
                        value={signedRecoveryBody?.nonce}
                      />
                      <Field
                        label="Issued at (chain ns)"
                        value={signedRecoveryBody?.issued_at}
                      />
                      <Field
                        label="Expires at (chain ns)"
                        value={signedRecoveryBody?.expires_at}
                      />
                      <Field
                        label="Security revision"
                        value={signedRecoveryBody?.security_revision}
                      />
                      <Field
                        label="Rejected requests in verified audit"
                        value={evidenceMetrics.authorizationFailures}
                      />
                      <p>
                        Approval scope binds domain, agent, task, action, epoch,
                        checkpoint, recipient and amount. Freshness must be
                        checked against chain time.
                      </p>
                    </Card>
                  </div>
                  {receipt}
                </>
              )}
              {active === "explorer" && explorerView}
              {active === "developers" && developersView}
              {active === "analytics" && analyticsView}
              {active === "token-economics" && token_economicsView}
              {active === "methodology" && methodologyView}
              {active === "about" && (
                <>
                  {aboutView}
                  <div className="two-grid">
                    <Card title="FIVE SYSTEMS. ONE RECOVERY PATH.">
                      <p>
                        PHOENIX coordinates recovery. STATEFLOW preserves work.
                        SENTINEL authorizes. GUARDIAN contains threats. REWIND
                        accounts for task payments.
                      </p>
                      <button
                        className="text-button"
                        onClick={() => navigate("methodology")}
                      >
                        Explore the methodology ↗
                      </button>
                    </Card>
                    <Card title="PROTOTYPE BOUNDARIES">
                      <p>
                        This hackathon reference system is local-first. Recovery
                        and escrow demonstrations run in a disposable sandbox.
                        Mainnet reads are available. Wallet actions require explicit operator configuration, a pinned contract hash and individual wallet approval.
                      </p>
                      <p>
                        A connected wallet does not authorize a payment or establish protocol safety. Wallet integrations run through NEAR Connect; contract trust still requires independent review.
                      </p>
                    </Card>
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
          <footer className="site-footer">
            <span>
              <span className="footer-mark">✦</span> PHOENIX{" "}
              <span className="muted">/</span> v5.0
            </span>
            <span>Read-only observations · explicit trust boundaries</span>
            <button
              className="text-button"
              onClick={() => navigate("methodology")}
            >
              Methodology & data ↗
            </button>
          </footer>
        </div>
      </CommandShell>
    </MotionProvider>
  );
}
