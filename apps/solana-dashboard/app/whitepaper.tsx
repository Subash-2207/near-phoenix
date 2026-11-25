import Link from "next/link";

export function Whitepaper() {
  return <article className="whitepaper">
    <section className="panel paper-intro">
      <h2>Continuity when a worker fails</h2>
      <p>PHOENIX defines a Solana task state machine for recovering failed agent work. Each task records a heartbeat, a checkpoint digest, and the execution generation that can act. A backup resumes with a new generation after an independent approval, so a stale worker can no longer commit task changes or request a payout.</p>
    </section>
    <div className="paper-grid">
      <section className="panel">
        <h2>Roles and authority</h2>
        <ul><li>The owner funds the task and appoints distinct role keys.</li><li>The operator posts heartbeats and checkpoint commitments.</li><li>The guardian can quarantine a task and invalidate open approvals.</li><li>The Sentinel approves an exact recovery or a limited payout.</li><li>The backup can recover only the approved checkpoint while the approval is valid.</li></ul>
      </section>
      <section className="panel">
        <h2>Escrow and replay</h2>
        <p>A task account holds native SOL principal. An approved payout binds the current operator, generation, amount, expiry and next nonce. Settlement consumes the approval and advances the nonce. The owner can refund remaining principal after a crash or quarantine, which closes the task.</p>
      </section>
      <section className="panel">
        <h2>Evidence</h2>
        <p>Read the program-owned task account at finalized commitment. A completed recovery records the generation, slot and committed digest. The digest identifies checkpoint bytes held by the worker. Its presence does not prove the correctness of work performed outside the chain.</p>
      </section>
      <section className="panel">
        <h2>Project delivery</h2>
        <p>The manager coordinates the six specialist roles. The workspace commits every completed artifact, leases work to an agent attempt, and lets a replacement resume from the last completed artifact after a failure. Customers approve a specific delivery digest. The workspace records settlement only after the matching payout and checkpoint are visible in the finalized Solana task.</p>
        <Link className="text-link" href="/explorer">Open the task explorer</Link>
      </section>
    </div>
  </article>;
}
