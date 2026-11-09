"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NearConnector } from "@hot-labs/near-connect";
import { MagneticButton } from "./ui";
import "./transaction-workbench.css";

type Network = "testnet" | "mainnet";
type Action = "heartbeat" | "report_crash";
type Plan = {
  network: Network; chainId: string; expiresAt: string; expectedCodeHash: string;
  observedBlock: {height: number; hash: string};
  transaction: {signerId: string; receiverId: string; actions: [{type: "FunctionCall"; params: {methodName: Action; args: Record<string, string>; gas: string; deposit: string}}]};
};
type Readiness = {enabled: boolean; network: string; coreId: string; expectedCodeHash: string; blockers: string[]};
type Receipt = {hash: string; sender: string; network: Network; receiver: string; action: Action; at: string};
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,45}$/;
const JOURNAL = "phoenix-last-operator-receipt";

async function request<T>(api: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(api + path, {method: body ? "POST" : "GET", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000),
    ...(body ? {headers: {"content-type": "application/json"}, body: JSON.stringify(body)} : {})});
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Service returned ${response.status}`);
  return result as T;
}
function assertPlan(value: Plan, account: string, agent: string, action: Action, health: {network: string; chainId?: unknown}): void {
  const tx = value?.transaction; const call = tx?.actions?.[0];
  if (!value || value.network !== health.network || value.chainId !== health.chainId || tx?.signerId !== account ||
      !/^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(tx?.receiverId ?? "") || !HASH.test(value.expectedCodeHash) ||
      !Array.isArray(tx.actions) || tx.actions.length !== 1 || call?.type !== "FunctionCall" || call.params.methodName !== action ||
      call.params.args.agent_id !== agent || call.params.deposit !== "0" || call.params.gas !== "30000000000000" ||
      !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.now() + 35000) {
    throw new Error("Action review failed validation. Reconnect and prepare a new review.");
  }
  const keys = Object.keys(call.params.args).sort().join(",");
  if (keys !== (action === "heartbeat" ? "agent_id,generation" : "agent_id") ||
      (action === "heartbeat" && (typeof call.params.args.generation !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(call.params.args.generation)))) throw new Error("Unexpected contract arguments");
}

export function TransactionWorkbench({api, session, health, getConnector, onConnect}: {
  api: string;
  session: {status: string; accountId: string | null; network: string | null};
  health: {network: string; chainId?: unknown; connected?: boolean} | null;
  getConnector: () => NearConnector | null;
  onConnect: () => void;
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [agent, setAgent] = useState(process.env.NEXT_PUBLIC_PHOENIX_AGENT_ID ?? "");
  const [action, setAction] = useState<Action>("heartbeat");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [verified, setVerified] = useState<Record<string, unknown> | null>(null);
  const [expired, setExpired] = useState(false);
  const live = useRef({session, health, agent, action});
  live.current = {session, health, agent, action};
  const connected = session.status === "connected" && health?.connected === true && session.network === health.network && health.chainId === health.network;
  const loadReadiness = useCallback(async () => {
    try { setReadiness(await request<Readiness>(api, "/api/network/readiness")); }
    catch (e) { setError(e instanceof Error ? e.message : "Network configuration unavailable"); }
  }, [api]);
  useEffect(() => { void loadReadiness(); }, [loadReadiness, health?.network]);
  useEffect(() => {
    setPlan(null); setAccepted(false); setConfirmation(""); setExpired(false);
  }, [agent, action, session.accountId, session.network, session.status, health?.network, health?.chainId, health?.connected]);
  useEffect(() => {
    if (!plan) return;
    const update = () => setExpired(Date.now() >= Date.parse(plan.expiresAt));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [plan]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOURNAL);
      const saved = raw && raw.length < 2000 ? JSON.parse(raw) as Receipt : null;
      if (saved && HASH.test(saved.hash) && ["testnet", "mainnet"].includes(saved.network) && ["heartbeat", "report_crash"].includes(saved.action) && typeof saved.sender === "string" && typeof saved.receiver === "string") setReceipt(saved);
    } catch { /* Receipt recovery is optional; never restore a signing approval. */ }
  }, []);
  async function prepare() {
    if (busyRef.current || !connected || !session.accountId || !health) return;
    busyRef.current = true; setBusy(true); setError(""); setMessage(""); setPlan(null); setAccepted(false);
    const snapshot = {accountId: session.accountId, agentId: agent.trim(), action};
    try {
      const result = await request<Plan>(api, "/api/network/prepare-action", snapshot);
      const current = live.current;
      if (current.session.accountId !== snapshot.accountId || current.agent.trim() !== snapshot.agentId || current.action !== snapshot.action || !current.health || current.session.status !== "connected") throw new Error("Workspace changed during review. Prepare again.");
      assertPlan(result, snapshot.accountId, snapshot.agentId, snapshot.action, current.health);
      if (result.transaction.receiverId !== readiness?.coreId || result.expectedCodeHash !== readiness?.expectedCodeHash) throw new Error("Operator configuration changed. Check readiness and prepare again.");
      setPlan(result); setMessage("Contract identity and action conditions checked against one finalized block.");
    } catch (e) { setError(e instanceof Error ? e.message : "Review could not be prepared"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function verify(item: Receipt = receipt!) {
    if (!item) return;
    setError(""); setVerified(null);
    try {
      const result = await request<Record<string, unknown>>(api, `/api/network/transaction?hash=${encodeURIComponent(item.hash)}&sender=${encodeURIComponent(item.sender)}`);
      if (result.network !== item.network || result.chainId !== item.network || result.receiver !== item.receiver) throw new Error("Receipt does not match the reviewed network and receiver");
      setVerified(result);
      const status = result.status as Record<string, unknown> | undefined;
      const receipts = Array.isArray(result.receiptsOutcome) ? result.receiptsOutcome : [];
      const failed = status && Object.hasOwn(status, "Failure") || receipts.some(r => r?.outcome?.status && Object.hasOwn(r.outcome.status, "Failure"));
      if (result.finalExecutionStatus === "FINAL" && failed) {
        setError("Finalized on chain with a failed execution. Inspect the receipt before taking another action.");
        setMessage("Finalized transaction found.");
      } else setMessage(result.finalExecutionStatus !== "FINAL" ? "Outcome is not final yet. Check again; the action will never retry automatically." : status && Object.hasOwn(status, "SuccessValue") ? "Finalized execution returned success. The receipt is available below." : "Outcome is uncertain. Inspect the receipt; no automatic retry will run.");
    } catch (e) { setError(`Outcome unverified: ${e instanceof Error ? e.message : "receipt lookup failed"}. Do not assume success or resubmit automatically.`); }
  }
  async function submit() {
    if (busyRef.current || !plan || !accepted || expired || !connected || !session.accountId || !health || (plan.network === "mainnet" && confirmation !== session.accountId)) return;
    busyRef.current = true; setBusy(true); setError(""); setMessage("Rechecking the contract and wallet before approval…");
    const reviewed = plan;
    try {
      const connector = getConnector();
      if (!connector || connector.network !== reviewed.network) throw new Error("Wallet network changed. Prepare a new review.");
      const fresh = await request<Plan>(api, "/api/network/prepare-action", {accountId: reviewed.transaction.signerId, agentId: agent.trim(), action});
      const current = live.current;
      if (!current.health || current.session.status !== "connected" || current.session.accountId !== reviewed.transaction.signerId || current.agent.trim() !== reviewed.transaction.actions[0].params.args.agent_id || current.action !== reviewed.transaction.actions[0].params.methodName) throw new Error("Workspace changed. Prepare again.");
      assertPlan(fresh, current.session.accountId, current.agent.trim(), current.action, current.health);
      if (JSON.stringify(fresh.transaction) !== JSON.stringify(reviewed.transaction) || fresh.expectedCodeHash !== reviewed.expectedCodeHash || fresh.network !== reviewed.network || Date.now() >= Date.parse(reviewed.expiresAt)) throw new Error("The review expired or on-chain conditions changed. Prepare again.");
      const wallet = await connector.wallet();
      const accounts = await wallet.getAccounts({network: reviewed.network});
      if (!accounts.some(a => a.accountId === reviewed.transaction.signerId) || connector.network !== reviewed.network || getConnector() !== connector || live.current.session.accountId !== reviewed.transaction.signerId || live.current.session.status !== "connected" || live.current.health?.connected !== true || live.current.health.network !== reviewed.network || live.current.health.chainId !== reviewed.network || live.current.agent.trim() !== reviewed.transaction.actions[0].params.args.agent_id || live.current.action !== reviewed.transaction.actions[0].params.methodName || Date.now() >= Date.parse(reviewed.expiresAt)) throw new Error("Wallet account changed. Prepare again.");
      setPlan(null); setAccepted(false); setMessage("Approve the exact action in your wallet. Network fees apply.");
      const call = reviewed.transaction.actions[0].params;
      const result = await wallet.signAndSendTransaction({network: reviewed.network, signerId: reviewed.transaction.signerId, receiverId: reviewed.transaction.receiverId,
        actions: [{type: "FunctionCall", params: {methodName: call.methodName, args: {...call.args}, gas: call.gas, deposit: call.deposit}}]});
      const hash = result?.transaction?.hash;
      if (!hash || !HASH.test(hash)) throw new Error("Wallet returned no verifiable transaction hash. Check your wallet history before retrying.");
      const item: Receipt = {hash, sender: reviewed.transaction.signerId, receiver: reviewed.transaction.receiverId, network: reviewed.network, action, at: new Date().toISOString()};
      setReceipt(item); setVerified(null);
      try { localStorage.setItem(JOURNAL, JSON.stringify(item)); } catch { /* In-memory receipt remains visible. */ }
      setMessage("Wallet returned a transaction hash. Checking the finalized outcome…");
      await verify(item);
    } catch (e) { setPlan(null); setAccepted(false); setError(e instanceof Error ? e.message : "Wallet request failed. Check wallet history before retrying."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function downloadReceipt() {
    const blob = new Blob([JSON.stringify({receipt, observation: verified, exportedAt: new Date().toISOString()}, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "phoenix-operation-receipt.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="tw-workbench card" aria-labelledby="tw-title">
    <div className="tw-heading"><div><p className="eyebrow">OPERATOR WORKSPACE</p><h2 id="tw-title">Every action. In the open.</h2><p>Connect your wallet, inspect the contract, then authorize one bounded action.</p></div><span className={`tw-network ${health?.connected ? "is-online" : ""}`}>{health?.network?.toUpperCase() ?? "NETWORK UNKNOWN"}</span></div>
    <ol className="tw-stages" aria-label="Transaction journey">{["Connect", "Inspect", "Review", "Authorize", "Verify"].map((label, i) => <li key={label} className={(i === 0 && connected || i === 1 && readiness?.enabled || i === 2 && plan || i === 4 && verified) ? "is-complete" : ""}><span>{String(i + 1).padStart(2, "0")}</span>{label}</li>)}</ol>
    <div className="tw-grid"><div className="tw-controls"><h3>Prepare an operator action</h3><p className="muted">Heartbeat refreshes a running agent. Crash reporting requires an expired heartbeat. Both attach zero NEAR; network fees still apply.</p>
      <label>Agent account<input value={agent} onChange={e => setAgent(e.target.value)} placeholder="your-agent.testnet" autoComplete="off" maxLength={64} disabled={busy}/></label>
      <label>Action<select value={action} onChange={e => setAction(e.target.value as Action)} disabled={busy}><option value="heartbeat">Send operator heartbeat</option><option value="report_crash">Report expired heartbeat</option></select></label>
      <div className="tw-actions">{!connected && <button className="button button-secondary" onClick={onConnect} disabled={busy || !health?.connected || health.network === "localnet"}>Connect wallet</button>}<MagneticButton onClick={() => void prepare()} disabled={busy || !connected || !readiness?.enabled || !agent.trim()}>{busy ? "Working…" : "Inspect & prepare"}<span aria-hidden="true">↗</span></MagneticButton><button className="button button-secondary" onClick={() => void loadReadiness()} disabled={busy}>Check readiness</button></div>
      {readiness && !readiness.enabled && <aside className="tw-blockers"><strong>Setup required</strong><ul>{readiness.blockers.map(b => <li key={b}>{b}</li>)}</ul></aside>}
    </div><div className="tw-review"><p className="eyebrow">YOUR REVIEW</p><h3>{plan ? "Know exactly what you authorize." : "A clear review comes first."}</h3>
      <dl>{[["Signer", plan?.transaction.signerId ?? session.accountId ?? "Connect a wallet"], ["Receiver", plan?.transaction.receiverId ?? readiness?.coreId ?? "Not configured"], ["Network", plan?.network ?? health?.network ?? "Unverified"], ["Method", plan?.transaction.actions[0].params.methodName ?? "Not prepared"], ["Attached deposit", "0 NEAR"], ["Gas cap", "30 Tgas · fees apply"], ["Finalized block", plan ? String(plan.observedBlock.height) : "Awaiting review"]].map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      {plan && <><details><summary>Inspect exact arguments & code hash</summary><pre>{JSON.stringify({arguments: plan.transaction.actions[0].params.args, codeHash: plan.expectedCodeHash, blockHash: plan.observedBlock.hash}, null, 2)}</pre></details><label className="tw-consent"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} disabled={busy}/><span>I reviewed this action and its network fee.</span></label>{plan.network === "mainnet" && <label>Confirm your mainnet signer<input value={confirmation} onChange={e => setConfirmation(e.target.value)} placeholder={session.accountId ?? ""} autoComplete="off" disabled={busy}/></label>}<MagneticButton disabled={busy || expired || !accepted || !connected || (plan.network === "mainnet" && confirmation !== session.accountId)} onClick={() => void submit()}>{expired ? "Review expired · prepare again" : "Continue in wallet"}<span aria-hidden="true">↗</span></MagneticButton><p className="muted">Review expires after 30 seconds. Conditions are checked again before the wallet opens.</p></>}
    </div></div>
    <p className="tw-status" role="status">{message}</p>{error && <p className="notice danger" role="alert">{error}</p>}
    {receipt && <section className="tw-receipt" aria-label="Latest wallet operation"><div><p className="eyebrow">LATEST OPERATION</p><h3>{receipt.action.replaceAll("_", " ")}</h3><p className="tw-hash">{receipt.hash}</p><p className="muted">{receipt.network.toUpperCase()} · {receipt.sender}</p></div><div className="tw-actions"><a className="button button-secondary" href={`https://${receipt.network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${receipt.hash}`} target="_blank" rel="noopener noreferrer">Open explorer ↗</a><button className="button button-secondary" onClick={() => void verify()} disabled={busy}>Verify outcome</button><button className="button button-secondary" onClick={downloadReceipt}>Export receipt</button></div>{verified && <details><summary>Inspect RPC evidence</summary><pre>{JSON.stringify(verified, null, 2)}</pre></details>}</section>}
  </section>;
}
