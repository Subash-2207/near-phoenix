"use client";

import Link from "next/link";
import { useState } from "react";
import { formatSol } from "./solana-rpc.mjs";

type RecoveryTask = {
  recoveryCount: string;
  recoveryHash: string;
  recoverySlot: string;
  escrowPaid: string;
  escrowRefunded: string;
  paymentNonce: string;
};

export function RecoveryProof({ task, finalizedSlot }: { task?: RecoveryTask; finalizedSlot?: number }) {
  const [copy, setCopy] = useState<{ digest: string; message: string } | null>(null);
  const digest = task && task.recoveryCount !== "0" ? task.recoveryHash : undefined;

  async function copyDigest(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopy({ digest: value, message: "Checkpoint digest copied." });
    } catch {
      setCopy({ digest: value, message: "Clipboard unavailable. Select the digest to copy it." });
    }
  }

  return <section id="recovery-proof" className="panel recovery-section" aria-labelledby="recovery-proof-title">
    <header className="recovery-section-heading">
      <div>
        <p className="topology-kicker"><span /> Proof of recovery</p>
        <h2 id="recovery-proof-title">A recovery. A record.</h2>
        <p>Inspect the recovered checkpoint and compare it with the task’s settlement record.</p>
      </div>
      <span className="tag">{finalizedSlot !== undefined ? `Finalized RPC slot ${finalizedSlot.toLocaleString()}` : "Awaiting account read"}</span>
    </header>
    <div className="recovery-section-grid">
      <div className="recovery-evidence-card">
        <h3>Recovered checkpoint</h3>
        {digest ? <>
          <p>Recorded recovery slot <strong>{task?.recoverySlot}</strong></p>
          <code className="recovery-digest">{digest}</code>
          <button type="button" className="button outline" onClick={() => void copyDigest(digest)}>Copy checkpoint digest</button>
          <span className="recovery-copy-status" role="status">{copy?.digest === digest ? copy?.message : ""}</span>
        </> : <p>Read a finalized PHOENIX task with a recorded recovery to inspect its checkpoint digest.</p>}
      </div>
      <div className="recovery-evidence-card">
        <h3>Escrow settlement</h3>
        {task ? <dl>
          <div className="data-row"><dt>Paid</dt><dd>{formatSol(task.escrowPaid)} SOL</dd></div>
          <div className="data-row"><dt>Refunded</dt><dd>{formatSol(task.escrowRefunded)} SOL</dd></div>
          <div className="data-row"><dt>Settlement nonce</dt><dd>{task.paymentNonce}</dd></div>
        </dl> : <p>Awaiting a task account.</p>}
        <Link className="text-link" href="/escrow">Open SOL escrow</Link>
      </div>
    </div>
  </section>;
}
