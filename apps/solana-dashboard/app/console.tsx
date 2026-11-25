"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { inspectSolanaAddress } from "./program-reader.mjs";
import { formatSol, isSolanaAddress } from "./solana-rpc.mjs";
import { RecoveryTopology } from "./recovery-topology";
import { RecoveryProof } from "./recovery-workspace";
import { useWallet } from "./wallet";

export type ConsoleMode = "recovery" | "security" | "escrow" | "evidence";
type Network = "devnet" | "mainnet";
const programs: Record<Network, string> = {
  devnet: process.env.NEXT_PUBLIC_PHOENIX_DEVNET_PROGRAM ?? "",
  mainnet: process.env.NEXT_PUBLIC_PHOENIX_MAINNET_PROGRAM ?? "",
};

function DataRow({label, value}: {label: string; value: string}) {
  return <div className="data-row"><dt>{label}</dt><dd>{value}</dd></div>;
}

function approval(timestamp: string, reference: number) {
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || seconds <= reference) return "None active";
  return "Expires " + new Date(seconds * 1000).toLocaleString();
}

export function Console({mode}: {mode: ConsoleMode}) {
  const { session } = useWallet();
  const [network, setNetwork] = useState<Network>("mainnet");
  const [accountAddress, setAccountAddress] = useState("");
  const [reading, setReading] = useState<Awaited<ReturnType<typeof inspectSolanaAddress>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const request = useRef<AbortController | null>(null);
  const current = reading?.task ?? undefined;
  const programConfigured = isSolanaAddress(programs[network]);

  useEffect(() => () => request.current?.abort(), []);

  function resetRead() {
    request.current?.abort();
    setBusy(false);
    setReading(null);
    setFailure("");
  }

  async function inspectAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetRead();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const data = await inspectSolanaAddress(network, programs[network], accountAddress.trim(), controller.signal);
      if (!controller.signal.aborted) setReading(data);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof TypeError) setFailure("Could not reach the Solana RPC. Check your connection and try again.");
        else if (error instanceof Error && error.name === "TimeoutError") setFailure("The Solana RPC did not respond in time. Try again.");
        else setFailure(error instanceof Error ? error.message : "Solana read failed.");
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const time = Math.floor(Date.now() / 1000);
  const hasTopology = mode === "recovery";
  return <>
    {hasTopology && <nav className="recovery-jumps" aria-label="On this page">
      <span>On this page</span>
      <a href="#topology-title">Topology</a>
      {current && <a href="#recovery-task">Task state</a>}
      <a href="#recovery-proof">Proof of recovery</a>
      <Link href="/projects">Project activity</Link>
    </nav>}
    <form className="panel account-form" onSubmit={(event) => void inspectAccount(event)}>
      <div><h2>Inspect a Solana address</h2><p>Check a wallet address, program, or task account using finalized Solana data.</p></div>
      <label>Network<select value={network} onChange={(event) => {
        resetRead();
        setNetwork(event.target.value as Network);
      }}><option value="devnet">Solana devnet</option><option value="mainnet">Solana mainnet</option></select></label>
      <label>Solana address<input autoComplete="off" spellCheck={false} required
        placeholder="Public Solana address"
        value={accountAddress} onChange={(event) => { resetRead(); setAccountAddress(event.target.value); }} /></label>
      {session && network === "mainnet" && <button className="button outline" type="button" onClick={() => {
        resetRead();
        setAccountAddress(session.address);
      }}>Use connected wallet</button>}
      <button className="button primary" type="submit" disabled={busy}>
        {busy ? "Reading…" : "Inspect finalized account"}
      </button>
      <p className="account-provider">This lookup sends the public address to {network === "mainnet" ? "PublicNode" : "Solana’s Devnet RPC"}.</p>
      {!programConfigured && <p>Recovery evidence requires a PHOENIX program deployment. This preview currently supports public account reads on {network}.</p>}
      {failure && <p className="warning-text" role="alert">{failure}</p>}
      {reading && <section className="account-observation" aria-labelledby="account-observation-title">
        <h3 id="account-observation-title">Finalized account</h3>
        <p role="status">{reading.account ? `${reading.task ? "PHOENIX task" : reading.account.kind} found on Solana ${reading.network}.` : `No account exists at this address on Solana ${reading.network} at the finalized slot below.`}</p>
        <dl>
          <DataRow label="Finalized slot" value={reading.slot.toLocaleString()} />
          {reading.account && <>
            <DataRow label="Native balance" value={reading.account.lamports === null ? "Unavailable" : formatSol(reading.account.lamports) + " SOL"} />
            <DataRow label="Owner program" value={reading.account.owner} />
          </>}
        </dl>
        {reading.invalidTask && <p>The configured program owns this account, but the data does not match the PHOENIX task layout.</p>}
        {reading.account?.kind === "System-owned account" && <p>Use the <Link className="text-link" href="/wallet">Wallet page</Link> to view your connected wallet.</p>}
        <a className="text-link" target="_blank" rel="noreferrer" href={"https://explorer.solana.com/address/" + reading.address + (reading.network === "devnet" ? "?cluster=devnet" : "")}>View on Solana Explorer</a>
      </section>}
    </form>
    {hasTopology && <RecoveryTopology task={current} remaining={current && formatSol(current.escrowRemaining) + " SOL"}
      reading={busy} />}
    {current && <div className={hasTopology ? "console-grid recovery-task-grid" : "console-grid"} id={hasTopology ? "recovery-task" : undefined}>
      <section className="panel workspace-summary" aria-label="Task state">
        <div className="panel-heading"><h2>Task state</h2><span className={"tag " + current.phase.toLowerCase()}>{current.phase}</span></div>
        <div className="metrics">
          <div><span>Generation</span><strong>{current.generation}</strong></div>
          <div><span>Recoveries</span><strong>{current.recoveryCount}</strong></div>
          <div><span>Escrow remaining</span><strong>{formatSol(current.escrowRemaining)} <small>SOL</small></strong></div>
        </div>
        {!hasTopology && <dl>
          {mode === "security" && <>
            <DataRow label="Guardian quarantine" value={current.phase === "Quarantined" ? "Active" : "Clear"} />
            <DataRow label="Sentinel recovery approval" value={approval(current.recoveryApproval, time)} />
            <DataRow label="Sentinel payout approval" value={approval(current.paymentApproval, time)} />
          </>}
          {mode === "escrow" && <>
            <DataRow label="Paid" value={formatSol(current.escrowPaid) + " SOL"} />
            <DataRow label="Refunded" value={formatSol(current.escrowRefunded) + " SOL"} />
            <DataRow label="Last settlement nonce" value={current.paymentNonce} />
          </>}
          {mode === "evidence" && <>
            <DataRow label="Recorded recovery slot" value={current.recoverySlot === "0" ? "Awaiting recovery" : current.recoverySlot} />
            <DataRow label="Recovered checkpoint digest" value={current.recoveryCount === "0" ? "Awaiting recovery" : current.recoveryHash} />
            <DataRow label="Evidence source" value={"Finalized program account"} />
          </>}
        </dl>}
      </section>
      {hasTopology ? <section className="panel" aria-labelledby="checkpoint-watch-title">
        <h2 id="checkpoint-watch-title">Checkpoint and heartbeat</h2>
        <dl>
          <DataRow label="Checkpoint sequence" value={current.checkpointSequence} />
          <DataRow label="Heartbeat sequence" value={current.heartbeatSequence} />
          <DataRow label="Recorded recovery slot" value={current.recoverySlot === "0" ? "Awaiting recovery" : current.recoverySlot} />
        </dl>
      </section> : null}
    </div>}
    {hasTopology && <RecoveryProof task={current} finalizedSlot={reading?.task ? reading.slot : undefined} />}
  </>;
}
