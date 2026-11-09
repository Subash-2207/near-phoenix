"use client";

import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMotionPreferences } from "./motion-preferences";
import { CopyButton, Icon } from "./ui";
import "./evidence-panels.css";

type EvidenceEvent = {
  id: number;
  at: string;
  kind: string;
  details: Record<string, unknown>;
};

const outcomeStates = [
  "Succeeded",
  "Pending",
  "Reserved",
  "Uncertain",
  "Failed",
  "Cancelled",
] as const;

function eventName(kind: string) {
  return kind.replaceAll("_", " ");
}

/** Every mark represents a returned record. Missing history never becomes a zero-rate plot. */
export function EvidenceChart({
  events,
  payments,
  source,
}: {
  events: EvidenceEvent[];
  payments: Array<Record<string, unknown>>;
  source: string;
}) {
  const { reduceMotion: reduce } = useMotionPreferences();
  const timelineId = useId();
  const paymentId = useId();
  const timed = events
    .map((event) => ({ ...event, time: Date.parse(event.at) }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time || a.id - b.id);
  const first = timed[0]?.time ?? 0;
  const span = timed.length ? timed[timed.length - 1].time - first : 0;
  const displayed = timed.slice(-12);
  const counts: Array<{ name: string; count: number }> = outcomeStates.map(
    (name) => ({
      name,
      count: payments.filter(
        (payment) => (payment.state ?? payment.status) === name,
      ).length,
    }),
  );
  const unknown =
    payments.length - counts.reduce((total, row) => total + row.count, 0);
  if (unknown) counts.push({ name: "Unreported", count: unknown });
  const maxCount = Math.max(1, ...counts.map((row) => row.count));
  const refunds = payments.filter(
    (payment) => payment.kind === "Refund",
  ).length;

  return (
    <div className="ep-chart-grid">
      <section className="ep-panel" aria-labelledby={timelineId}>
        <header className="ep-panel-head">
          <span className="ep-icon">
            <Icon name="activity" />
          </span>
          <div>
            <p className="ep-kicker">LOCAL SANDBOX · CURRENT RUN</p>
            <h3 id={timelineId}>The recovery, in time</h3>
          </div>
          <span className="ep-count">
            {events.length ? `${events.length} events` : "Awaiting data"}
          </span>
        </header>
        {timed.length ? (
          <>
            <div className="ep-chart-axis">
              <span>Elapsed from first observed event</span>
              <span>{(span / 1000).toFixed(2)}s</span>
            </div>
            <ol
              className="ep-timing-chart"
              aria-label="Sandbox event arrival times"
            >
              {displayed.map((event) => {
                const elapsed = (event.time - first) / 1000;
                const proportion = span > 0 ? (event.time - first) / span : 0;
                return (
                  <li key={`${event.id}-${event.at}`}>
                    <span
                      className="ep-event-name"
                      title={eventName(event.kind)}
                    >
                      {eventName(event.kind)}
                    </span>
                    <span className="ep-timing-track" aria-hidden="true">
                      <motion.span
                        className={`ep-timing-bar ${event.kind.includes("failed") || event.kind.includes("quarantined") ? "ep-bar-warning" : ""}`}
                        initial={false}
                        animate={{ scaleX: proportion }}
                        style={{ transformOrigin: "left" }}
                        transition={{
                          duration: reduce ? 0 : 0.45,
                          ease: "easeOut",
                        }}
                      />
                      <span
                        className="ep-timing-dot"
                        style={{ left: `${proportion * 100}%` }}
                      />
                    </span>
                    <time dateTime={event.at} title={event.at}>
                      +{elapsed.toFixed(2)}s
                    </time>
                  </li>
                );
              })}
            </ol>
            <p className="ep-caption">
              {timed.length > 12 ? "Latest 12 timed events shown. " : ""}Arrival
              time at the local backend, not chain execution latency.{" "}
              {events.length !== timed.length
                ? `${events.length - timed.length} record(s) without valid timestamps omitted.`
                : ""}
            </p>
          </>
        ) : (
          <div className="ep-chart-empty">
            <Icon name="clock" size={28} />
            <strong>No timed observations yet</strong>
            <p>
              Run a sandbox walkthrough to trace real event arrivals. No
              historical data is generated.
            </p>
            <div className="ep-empty-grid" aria-hidden="true" />
          </div>
        )}
      </section>

      <section className="ep-panel" aria-labelledby={paymentId}>
        <header className="ep-panel-head">
          <span className="ep-icon ep-icon-violet">
            <Icon name="escrow" />
          </span>
          <div>
            <p className="ep-kicker">RETURNED OPERATIONS</p>
            <h3 id={paymentId}>Settlement outcomes</h3>
          </div>
        </header>
        {payments.length ? (
          <>
            <div className="ep-outcome-total">
              <strong>{payments.length}</strong>
              <span>
                configured operation records
                <br />
                <small>
                  {refunds} labeled refund{refunds === 1 ? "" : "s"} included
                </small>
              </span>
            </div>
            <ul
              className="ep-outcome-chart"
              aria-label="Returned operation counts by state"
            >
              {counts.map((row) => (
                <li key={row.name} data-state={row.name}>
                  <span>{row.name}</span>
                  <span className="ep-outcome-track" aria-hidden="true">
                    <motion.span
                      initial={false}
                      animate={{ scaleX: row.count / maxCount }}
                      style={{ transformOrigin: "left" }}
                      transition={{ duration: reduce ? 0 : 0.45 }}
                    />
                  </span>
                  <strong>{row.count}</strong>
                </li>
              ))}
            </ul>
            <p className="ep-caption">
              Counts cover configured operation IDs only. Pending and uncertain
              operations are not finalized payments.
            </p>
          </>
        ) : (
          <div className="ep-chart-empty">
            <Icon name="escrow" size={28} />
            <strong>No operation records returned</strong>
            <p>
              Outcomes appear when configured REWIND operation lookups return
              evidence. This is not a zero-payment claim.
            </p>
            <div className="ep-empty-grid" aria-hidden="true" />
          </div>
        )}
        <footer className="ep-source">
          <span aria-hidden="true" />
          {source || "Source unavailable"}
        </footer>
      </section>
    </div>
  );
}

const methodology = [
  {
    name: "Agent monitoring",
    product: "PHOENIX",
    icon: "activity",
    description:
      "Read the registered agent status and compare its heartbeat with chain time. A running status alone does not establish current availability.",
    evidence:
      "Agent identity · heartbeat timestamp · timeout · finalized observation",
    boundary:
      "Missing or inconsistent observations remain unknown. Monitoring does not authorize an action.",
  },
  {
    name: "Failure detection",
    product: "PHOENIX",
    icon: "clock",
    description:
      "Detect a missed heartbeat using the configured timeout. The coordinator evaluates the current generation before proposing a recovery.",
    evidence:
      "Observed heartbeat expiry · chain timestamp · recovery generation",
    boundary:
      "A timeout is a liveness signal, not proof of malicious behavior.",
  },
  {
    name: "Checkpoint verification",
    product: "STATEFLOW",
    icon: "lock",
    description:
      "Check the signed checkpoint, its domain, digest lineage and expiry before restoring task state. Reject missing, stale or inconsistent evidence.",
    evidence: "Signed checkpoint · digest · sequence · expiry · domain",
    boundary:
      "A digest identifies content; the checkpoint and its signature still require validation.",
  },
  {
    name: "Backup selection",
    product: "RECOVERY MESH",
    icon: "recovery",
    description:
      "Select an eligible backup from registered identities. Recovery approval binds the backup and checkpoint to the task and current recovery epoch.",
    evidence:
      "Registered backup identity · task scope · independent recovery approval",
    boundary:
      "Being registered does not mean a backup is active or currently reachable.",
  },
  {
    name: "Recovery",
    product: "PHOENIX + STATEFLOW",
    icon: "refresh",
    description:
      "Restore the verified checkpoint and advance the recovery generation. Epoch fencing prevents the previous worker from continuing with stale authority.",
    evidence: "Epoch transition · restored state · current worker identity",
    boundary:
      "The demonstration worker is deterministic test code, not a production agent runner.",
  },
  {
    name: "Payment authorization",
    product: "SENTINEL",
    icon: "sentinel",
    description:
      "Require independent, expiring approval for the exact task, recipient, amount, operation and epoch. Consume a one-time nonce under the configured policy.",
    evidence:
      "Signed approval · nonce · expiry · policy revision · settlement intent",
    boundary:
      "Recovery success, risk scores and a connected wallet never grant spending permission.",
  },
  {
    name: "Escrow finalization",
    product: "REWIND",
    icon: "escrow",
    description:
      "Track the reserved operation through asynchronous transfer and callback. Only a successful final state counts as settled; uncertain outcomes remain unresolved.",
    evidence:
      "Operation ID · kind · approved amount · terminal callback outcome",
    boundary:
      "Pending is not paid. Refunds retain their own operation kind and authorization rules.",
  },
  {
    name: "Recovery proof",
    product: "PROOF-OF-RECOVERY",
    icon: "security",
    description:
      "Read the recovery epoch record and any SENTINEL-signed settlement receipt. Keep the signed attestation, RPC observation and independent verification distinct.",
    evidence:
      "Checkpoint commitment · backup · settlement reference · receipt · block reference",
    boundary:
      "The dashboard reads returned evidence; it does not independently verify a blockchain inclusion proof.",
  },
] as const;

export function EvidenceDisclosure({
  title,
  children,
  subtitle,
}: {
  title: string;
  children: ReactNode;
  subtitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const { reduceMotion: reduce } = useMotionPreferences();
  const panel = useId();
  return (
    <div className="ep-disclosure">
      <button
        className="ep-disclosure-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </span>
        <span className="ep-disclosure-plus" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panel}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 230, damping: 30 }
            }
            style={{ overflow: "hidden" }}
          >
            <div className="ep-disclosure-body">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MethodFlow() {
  const [selected, setSelected] = useState(0);
  const { reduceMotion: reduce } = useMotionPreferences();
  const panelId = useId();
  const step = methodology[selected];
  const commands = [
    { label: "TypeScript checks", value: "npm run typecheck" },
    {
      label: "Backend security and API tests",
      value: "npm test -w @phoenix/backend",
    },
    {
      label: "Wallet session boundary",
      value: "npm run test:wallet -w @phoenix/dashboard",
    },
    {
      label: "Evidence metric assertions",
      value: "npm run test:evidence -w @phoenix/dashboard",
    },
    { label: "Rust protocol tests", value: "cargo test --workspace --locked" },
    {
      label: "Recovery service tests",
      value: "cargo test --manifest-path services/recovery/Cargo.toml --locked",
    },
    {
      label: "Local sandbox recovery receipt suite",
      value: "bash scripts/test-stage-a.sh",
    },
  ];

  return (
    <section className="ep-method">
      <div className="ep-method-intro">
        <span className="ep-concept-label">
          <Icon name="methodology" size={14} /> CONCEPTUAL PROCESS
        </span>
        <p>
          Explore the eight trust boundaries. This diagram explains the
          protocol; it does not represent live telemetry.
        </p>
      </div>
      <ol className="ep-method-steps" aria-label="Recovery methodology">
        {methodology.map((item, index) => (
          <li key={item.name}>
            <button
              type="button"
              aria-pressed={selected === index}
              aria-controls={panelId}
              onClick={() => setSelected(index)}
            >
              <span className="ep-step-top">
                <span className="ep-step-number">0{index + 1}</span>
                <Icon name={item.icon} size={20} />
              </span>
              <strong>{item.name}</strong>
              <small>{item.product}</small>
              {selected === index && (
                <motion.span
                  className="ep-step-underline"
                  layoutId={`${panelId}-underline`}
                  transition={{ duration: reduce ? 0 : 0.25 }}
                />
              )}
            </button>
          </li>
        ))}
      </ol>
      <div
        className="ep-method-detail"
        id={panelId}
        role="region"
        aria-label={`Step ${selected + 1}: ${step.name}`}
      >
        <motion.div
          key={step.name}
          initial={reduce ? false : { opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : 0.2 }}
        >
          <p className="ep-kicker">
            STEP 0{selected + 1} / 08 · {step.product}
          </p>
          <h3>{step.name}</h3>
          <p>{step.description}</p>
          <div className="ep-method-evidence">
            <Icon name="lock" size={16} />
            <span>
              <strong>Evidence required</strong>
              {step.evidence}
            </span>
          </div>
          <p className="ep-boundary">{step.boundary}</p>
        </motion.div>
      </div>
      <div className="ep-method-disclosures">
        <EvidenceDisclosure
          title="Reproduce the evidence"
          subtitle="Commands run from the repository root"
        >
          <p>
            These are reproduction commands, not a claim that a test has run.
            Rust and sandbox suites require the installed toolchain and local
            sandbox dependencies. The Stage A script rebuilds local WASM and
            uses disposable sandbox deployments.
          </p>
          <div className="ep-command-list">
            {commands.map((command) => (
              <div key={command.value}>
                <span>{command.label}</span>
                <div>
                  <code>{command.value}</code>
                  <CopyButton
                    value={command.value}
                    label={`Copy ${command.label.toLowerCase()} command`}
                  />
                </div>
              </div>
            ))}
          </div>
        </EvidenceDisclosure>
        <EvidenceDisclosure
          title="Data provenance & measurement definitions"
          subtitle="Understand what each observation can establish"
        >
          <ul>
            <li>
              <strong>Local sandbox events:</strong> backend timestamps describe
              event arrival in one returned demo run. Failure-to-restoration
              latency is one observed interval.
            </li>
            <li>
              <strong>Configured contract views:</strong> RPC observations
              identify a selected network and finalized block. They do not
              independently prove blockchain inclusion.
            </li>
            <li>
              <strong>GUARDIAN history:</strong> security counts require
              signatures, sequence, digest linkage and the configured on-chain
              audit head to verify.
            </li>
            <li>
              <strong>Recovery success rate and availability:</strong> remain
              unavailable without complete attempt and observation windows. No
              denominator is inferred from one receipt.
            </li>
            <li>
              <strong>Settlement counts:</strong> include only returned
              configured operations. A completed refund is not a completed
              payment.
            </li>
          </ul>
        </EvidenceDisclosure>
        <EvidenceDisclosure
          title="Security assumptions & known limitations"
          subtitle="Prototype scope and remaining verification boundaries"
        >
          <p>
            The coordinator depends on reachable RPC observations, registered
            worker identities, independent approval policy and correctly
            configured domains. Local sandbox evidence does not establish
            public-network deployment or production reliability.
          </p>
          <p>
            GUARDIAN thresholds and complete approval history are not exposed by
            the current dashboard API. Missing fields remain unavailable. The
            dashboard does not reproduce an independent cryptographic
            verification of recovery receipts.
          </p>
          <p>
            Wallet dependency security advisories remain unresolved. Wallet
            sessions remain read-only; no transaction signing, deployment or
            withdrawal action is exposed.
          </p>
        </EvidenceDisclosure>
      </div>
    </section>
  );
}
