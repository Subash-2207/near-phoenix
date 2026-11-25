"use client";

import { useState, type ReactNode } from "react";

const stages = [
  { id: "primary", team: "Phoenix Core", name: "Primary agent", x: 125, y: 64, detail: "The primary worker reports progress through heartbeats." },
  { id: "coordinator", team: "Phoenix", name: "Recovery coordinator", x: 375, y: 64, detail: "The coordinator detects an expired heartbeat and tracks the current execution generation." },
  { id: "backup", team: "Recovery Mesh", name: "Backup agent", x: 625, y: 64, detail: "An authorized backup resumes the task in a new execution generation." },
  { id: "checkpoint", team: "Stateflow", name: "Checkpoint", x: 875, y: 64, detail: "The committed sequence and digest identify the task state available for recovery." },
  { id: "authorization", team: "Sentinel", name: "Authorization", x: 875, y: 237, detail: "Independent approval authorizes a recovery or payout within its approval window." },
  { id: "settlement", team: "Rewind", name: "Escrow settlement", x: 625, y: 237, detail: "The task records approved SOL payouts and the remaining escrow." },
  { id: "evidence", team: "Auditable evidence", name: "Proof of recovery", x: 375, y: 237, detail: "The recovery slot and checkpoint digest make the recovered state inspectable." },
] as const;

type Stage = typeof stages[number]["id"];
type Task = {
  phase: string; generation: string; heartbeatSequence: string; checkpointSequence: string;
  recoveryCount: string; recoverySlot: string; recoveryApproval: string; paymentApproval: string;
  escrowPaid: string; escrowRefunded: string;
};
type Props = {
  task: Task | undefined;
  remaining: string | undefined;
  reading: boolean;
};

function Glyph({ stage }: { stage: Stage }) {
  const worker = <><rect x="7" y="8" width="18" height="16" rx="4" /><path d="M16 4v4M4 13h3m-3 6h3m18-6h3m-3 6h3M11 28v-4m10 4v-4m-9-9h.1m7.9 0h.1m-7 5h6" /></>;
  const icons: Record<Stage, ReactNode> = {
    primary: worker,
    backup: worker,
    coordinator: <path d="m16 4 5 10 7-5-5 12-7 7-7-7L4 9l7 5 5-10Zm-5 10 5 8 5-8m-5 8v6" />,
    checkpoint: <><ellipse cx="16" cy="8" rx="10" ry="4" /><path d="M6 8v15c0 2.2 4.5 4 10 4s10-1.8 10-4V8M6 15c0 2.2 4.5 4 10 4s10-1.8 10-4" /></>,
    authorization: <path d="m16 4 10 4v8c0 5-4 9-10 12C10 25 6 21 6 16V8l10-4Zm-4 12 3 3 5-6" />,
    settlement: <><path d="M25 10V7H9a4 4 0 0 0 0 8h18v12H9a4 4 0 0 1-4-4V11m22 4v-3H9" /><path d="M27 19h-6a2 2 0 0 0 0 4h6m-5-2h.1" /></>,
    evidence: <path d="m16 4 10 6v12l-10 6-10-6V10l10-6Zm-4 12 3 3 5-6" />,
  };
  return <svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">{icons[stage]}</svg>;
}

export function RecoveryTopology({ task, remaining, reading }: Props) {
  const [selected, setSelected] = useState<Stage>("coordinator");
  const stage = stages.find(({ id }) => id === selected) ?? stages[1];
  const visited = new Set<Stage>();
  if (task) {
    visited.add("coordinator");
    if (task.heartbeatSequence !== "0") visited.add("primary");
    if (task.checkpointSequence !== "0") visited.add("checkpoint");
    if (task.recoveryCount !== "0") { visited.add("backup"); visited.add("evidence"); }
    if (task.recoveryApproval !== "0" || task.paymentApproval !== "0") visited.add("authorization");
    if (task.escrowPaid !== "0" || task.escrowRefunded !== "0") visited.add("settlement");
  }
  const blocked = task?.phase === "Crashed" || task?.phase === "Quarantined";
  const focus = reading ? "coordinator" : stage.id;
  const status = reading ? "Reading finalized account…" : task ? "Finalized task loaded" : "Waiting for a task account";
  const facts = [
    ["Execution generation", task?.generation],
    ["Checkpoint sequence", task?.checkpointSequence],
    ["Recovery slot", task?.recoverySlot && task.recoverySlot !== "0" ? task.recoverySlot : "—"],
    ["Escrow remaining", remaining],
  ];

  return <section className="recovery-topology" aria-labelledby="topology-title" data-running={reading}>
    <div className="topology-heading">
      <div>
        <p className="topology-kicker"><span /> Recovery topology</p>
        <h2 id="topology-title">Resilience, connected.</h2>
        <p>From the first heartbeat to accountable settlement.</p>
      </div>
    </div>
    <div className="topology-status">
      <span><i aria-hidden="true" />{status}</span>
      <span>Solana account</span>
    </div>
    <div className="topology-canvas">
      <div className="topology-graph">
        <svg className="topology-links" viewBox="0 0 1000 346" preserveAspectRatio="none" aria-hidden="true">
          {stages.slice(1).map((target, i) => {
            const start = stages[i];
            const connected = focus === target.id || focus === start.id;
            const line = `M${start.x} ${start.y} L${target.x} ${target.y}`;
            return <g key={target.id} data-active={reading && connected} data-highlight={connected}>
              <path className="topology-wire-bed" d={line} vectorEffect="non-scaling-stroke" />
              <path className="topology-wire" d={line} vectorEffect="non-scaling-stroke" />
            </g>;
          })}
        </svg>
        <ol className="topology-nodes" aria-label="Recovery components">
          {stages.map(({ id, team, name }) => <li key={id}>
            <button type="button" aria-pressed={stage.id === id} onClick={() => setSelected(id)}
              data-active={reading && focus === id} data-state={blocked && id === "coordinator" ? "blocked" : visited.has(id) ? "observed" : "unknown"}>
              <span className="topology-icon"><Glyph stage={id} /><i aria-hidden="true" /></span>
              <span className="topology-team">{team}</span>
              <strong>{name}</strong>
            </button>
          </li>)}
        </ol>
      </div>
      <div className="topology-legend" aria-label="Status legend">
        <span><i data-tone="observed" /> Event recorded</span><span><i data-tone="active" /> Analyzing</span>
        <span><i data-tone="blocked" /> Interrupted</span><span><i /> Awaiting evidence</span>
      </div>
    </div>
    <div className="topology-details">
      <div><span className="topology-team">{stage.team}</span><h3>{stage.name}</h3><p>{stage.detail}</p></div>
      <dl>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "—"}</dd></div>)}</dl>
    </div>
  </section>;
}
