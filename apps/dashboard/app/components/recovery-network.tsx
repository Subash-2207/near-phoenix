"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMotionPreferences } from "./motion-preferences";
import {
  backupActivationTransition,
  checkpointCommitmentTransition,
  finalizedPaymentTransition,
  verifiedReceiptTransition,
} from "../recovery-transitions.mjs";
import "./recovery-network.css";

type RecordValue = Record<string, unknown>;
type RecoveryEvent = {
  id: number;
  at: string;
  kind: string;
  details: RecordValue;
};
type RecoveryNetworkProps = {
  agent: RecordValue | null;
  checkpoint: RecordValue | null;
  backup: RecordValue | null;
  sentinel: RecordValue | null;
  guardian: RecordValue | null;
  escrow: RecordValue | null;
  proof: RecordValue | null;
  events: RecoveryEvent[];
  demoStatus: string;
  source: string;
  heartbeat: string;
  stale?: boolean;
};
type StageId =
  | "primary"
  | "coordinator"
  | "backup"
  | "checkpoint"
  | "sentinel"
  | "rewind"
  | "proof";
type Tone = "unknown" | "observed" | "pending" | "failed";
type Stage = {
  id: StageId;
  name: string;
  product: string;
  x: number;
  y: number;
  tone: Tone;
  status: string;
  fields: [string, unknown][];
  explanation: string;
};

function display(value: unknown): string {
  if (value === null || value === undefined || value === "")
    return "Not reported";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
const eventStages: Record<string, StageId> = {
  primary_heartbeat: "primary",
  primary_failed: "primary",
  checkpoint_committed: "checkpoint",
  backup_restored: "backup",
  suspicious_payment_rejected: "sentinel",
  payment_settled: "rewind",
  duplicate_payment_prevented: "rewind",
  guardian_quarantined: "primary",
  demo_complete: "proof",
};
function NodeGlyph({ id }: { id: StageId }) {
  const shared = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.55,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (id === "primary" || id === "backup")
    return (
      <g {...shared}>
        <rect x="-12" y="-10" width="24" height="20" rx="5" />
        <path d="M-5-14v4M5-14v4M-5 10v4M5 10v4M-16-4h4M12-4h4M-16 4h4M12 4h4" />
        <circle cx="-4" cy="-2" r="1" />
        <circle cx="4" cy="-2" r="1" />
        <path d="M-4 4h8" />
      </g>
    );
  if (id === "coordinator")
    return (
      <g {...shared}>
        <path d="m-18-11 12 4 6-17L6-7l12-4-5 16L0 21-13 5z" />
        <path d="M-18-11 0 3l18-14M0 3v18M-6-7 0 3l6-10" />
      </g>
    );
  if (id === "checkpoint")
    return (
      <g {...shared}>
        <ellipse cy="-9" rx="12" ry="4" />
        <path d="M-12-9V8c0 5 24 5 24 0V-9M-12-1c0 5 24 5 24 0" />
      </g>
    );
  if (id === "sentinel")
    return (
      <g {...shared}>
        <path d="m0-15 13 5v9c0 8-13 16-13 16S-13 7-13-1v-9z" />
        <path d="m-6 0 4 4 8-9" />
      </g>
    );
  if (id === "rewind")
    return (
      <g {...shared}>
        <rect x="-14" y="-10" width="28" height="22" rx="4" />
        <path d="M-14-4h28M2 2h12v6H2zM-8-15h17v5" />
        <circle cx="6" cy="5" r=".6" />
      </g>
    );
  return (
    <g {...shared}>
      <path d="m0-15 13 7v16L0 15-13 8V-8z" />
      <path d="m-6 0 4 4 8-8" />
    </g>
  );
}

export function RecoveryNetwork(props: RecoveryNetworkProps) {
  const {
    agent,
    checkpoint,
    backup,
    sentinel,
    guardian,
    escrow,
    proof,
    events,
    demoStatus,
    source,
    heartbeat,
    stale = false,
  } = props;
  const [selected, setSelected] = useState<StageId>("coordinator");
  const [mode, setMode] = useState<"observed" | "demo">("observed");
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const demoActive = mode === "demo";
  const { reduceMotion } = useMotionPreferences();
  const gradientId = useId().replace(/:/g, "");
  const receipt = object(proof?.receipt);
  const signed = object(receipt?.signed_receipt);
  const signedBody = object(signed?.body);
  const rpcObservation = !stale && /\bRPC\b/i.test(source);
  const payments = Array.isArray(escrow?.payments)
    ? (escrow.payments as RecordValue[])
    : [];
  const successful = payments.filter(
    (payment) =>
      payment.status === "Succeeded" || payment.state === "Succeeded",
  );
  const failed = payments.filter(
    (payment) => payment.status === "Failed" || payment.state === "Failed",
  );
  const pending = payments.filter((payment) =>
    ["Reserved", "Pending", "Uncertain"].includes(
      String(payment.status ?? payment.state),
    ),
  );
  const paymentStatus = (payment: RecordValue) =>
    String(payment.state ?? payment.status ?? "Not reported");
  const paymentKey = (payment: RecordValue, index: number) =>
    String(payment.operationId ?? payment.operation_id ?? `operation-${index}`);
  const currentPayments = new Map(
    payments.map((payment, index) => [
      paymentKey(payment, index),
      paymentStatus(payment),
    ]),
  );
  const previousPayments = useRef(currentPayments);
  const hasPreviousPaymentObservation = useRef(false);
  const [settlementPulse, setSettlementPulse] = useState("");
  const [backupPulse, setBackupPulse] = useState(0);
  const [checkpointPulse, setCheckpointPulse] = useState(0);
  const currentBackupActive = backup?.backupActive === true;
  const previousBackupActive = useRef(currentBackupActive);
  const hasPreviousBackupObservation = useRef(false);
  const checkpointDigest =
    typeof checkpoint?.digest === "string" ? checkpoint.digest : "";
  const previousCheckpointDigest = useRef(checkpointDigest);
  const hasPreviousCheckpointObservation = useRef(false);
  const verifiedReceiptKey =
    rpcObservation &&
    receipt &&
    signed &&
    String(receipt.epoch_to ?? "") &&
    String(signed.signature ?? "") &&
    String(receipt.verified_by ?? "")
      ? `${String(receipt.epoch_to ?? "")}:${String(signed.signature ?? "")}`
      : "";
  const previousReceiptKey = useRef(verifiedReceiptKey);
  const hasPreviousReceiptObservation = useRef(false);
  const [receiptArrivalKey, setReceiptArrivalKey] = useState("");
  const settledPaymentKeys = new Set(
    successful.map((payment, index) => paymentKey(payment, index)),
  );
  useEffect(() => {
    if (rpcObservation && !demoActive) {
      if (
        hasPreviousBackupObservation.current &&
        backupActivationTransition(
          previousBackupActive.current,
          currentBackupActive,
          rpcObservation,
          demoActive,
        )
      ) {
        setBackupPulse((pulse) => pulse + 1);
      }
      previousBackupActive.current = currentBackupActive;
      hasPreviousBackupObservation.current = true;
    } else {
      hasPreviousBackupObservation.current = false;
      setBackupPulse(0);
    }
  }, [currentBackupActive, rpcObservation, demoActive]);
  useEffect(() => {
    if (rpcObservation && !demoActive) {
      if (
        hasPreviousCheckpointObservation.current &&
        checkpointCommitmentTransition(
          previousCheckpointDigest.current,
          checkpointDigest,
          rpcObservation,
          demoActive,
        )
      ) {
        setCheckpointPulse((pulse) => pulse + 1);
      }
      previousCheckpointDigest.current = checkpointDigest;
      hasPreviousCheckpointObservation.current = true;
    } else {
      hasPreviousCheckpointObservation.current = false;
      setCheckpointPulse(0);
    }
  }, [checkpointDigest, rpcObservation, demoActive]);
  useEffect(() => {
    if (rpcObservation && !demoActive) {
      if (hasPreviousPaymentObservation.current) {
        const newlySettled = payments.find((payment, index) => {
          return finalizedPaymentTransition(
            previousPayments.current.get(paymentKey(payment, index)),
            payment,
            rpcObservation,
            demoActive,
          );
        });
        if (newlySettled) {
          const index = payments.indexOf(newlySettled);
          setSettlementPulse(paymentKey(newlySettled, index));
        }
      }
      previousPayments.current = currentPayments;
      hasPreviousPaymentObservation.current = true;
    } else {
      previousPayments.current = currentPayments;
      hasPreviousPaymentObservation.current = false;
      setSettlementPulse("");
    }
  }, [payments, rpcObservation, demoActive]);
  useEffect(() => {
    if (rpcObservation && !demoActive) {
      if (
        hasPreviousReceiptObservation.current &&
        verifiedReceiptTransition(
          previousReceiptKey.current,
          verifiedReceiptKey,
          rpcObservation,
          demoActive,
        )
      ) {
        setReceiptArrivalKey(verifiedReceiptKey);
      }
      previousReceiptKey.current = verifiedReceiptKey;
      hasPreviousReceiptObservation.current = true;
    } else {
      hasPreviousReceiptObservation.current = false;
      setReceiptArrivalKey("");
    }
  }, [verifiedReceiptKey, rpcObservation, demoActive]);
  const selectedEvent = events.find((event) => event.id === selectedEventId);
  const eventStage = selectedEvent
    ? eventStages[selectedEvent.kind]
    : undefined;
  const hasObservation = Boolean(
    agent?.status ||
    checkpoint?.digest ||
    receipt ||
    escrow?.taskId ||
    escrow?.task_id,
  );
  const neutralize = (tone: Tone): Tone => (stale ? "unknown" : tone);
  const stages: Stage[] = [
    {
      id: "primary",
      name: "Primary agent",
      product: "PHOENIX CORE",
      x: 104,
      y: 116,
      tone: neutralize(
        guardian?.quarantine === true || heartbeat === "expired"
          ? "failed"
          : heartbeat === "live"
            ? "observed"
            : "unknown",
      ),
      status: stale
        ? "Observation stale"
        : guardian?.quarantine === true
          ? "Quarantined"
          : heartbeat === "live"
            ? "Heartbeat observed"
            : heartbeat === "expired"
              ? "Heartbeat expired"
              : "Awaiting telemetry",
      fields: [
        ["Agent identity", agent?.id],
        ["Contract state", agent?.status],
        ["Heartbeat", heartbeat],
        ["Heartbeat time (ns)", agent?.heartbeatAt ?? agent?.heartbeat_at],
      ],
      explanation:
        "Liveness is evaluated against the finalized block timestamp. A heartbeat is an observation, not a security attestation.",
    },
    {
      id: "coordinator",
      name: "Recovery coordinator",
      product: "PHOENIX",
      x: 352,
      y: 116,
      tone: neutralize(agent?.status === "Recovering" ? "pending" : "unknown"),
      status: stale
        ? "Observation stale"
        : agent?.status === "Recovering"
          ? "Recovery in progress"
          : "Fenced orchestration",
      fields: [
        ["Recovery epoch", agent?.generation],
        ["Task", backup?.taskId],
        ["Security revision", agent?.securityRevision],
        ["Service health", "Not exposed by the API"],
      ],
      explanation:
        "Coordinates failure detection and fenced restoration. Contract state does not independently establish coordinator service health.",
    },
    {
      id: "backup",
      name: "Backup agent",
      product: "RECOVERY MESH",
      x: 600,
      y: 116,
      tone: neutralize(backup?.backupActive === true ? "observed" : "unknown"),
      status: stale
        ? "Observation stale"
        : backup?.backupActive === true
          ? "Activation observed"
          : "Awaiting activation",
      fields: [
        ["Current worker", backup?.currentWorker],
        ["Registered backups", backup?.registeredBackups],
        ["Activation observed", backup?.backupActive],
        ["Task", backup?.taskId],
      ],
      explanation:
        "Activation is reported only when the recovery receipt matches the current worker identity and recovery epoch.",
    },
    {
      id: "checkpoint",
      name: "Checkpoint",
      product: "STATEFLOW",
      x: 848,
      y: 116,
      tone: neutralize(checkpoint?.digest ? "observed" : "unknown"),
      status: stale
        ? "Observation stale"
        : checkpoint?.digest
          ? "Commitment observed"
          : "No checkpoint reported",
      fields: [
        ["Sequence", checkpoint?.sequence],
        ["Digest", checkpoint?.digest],
        ["Epoch", checkpoint?.generation ?? checkpoint?.epoch],
        ["Expires at", checkpoint?.expires_at],
      ],
      explanation:
        "This view shows the contract checkpoint commitment. Blob integrity and restoration checks remain the responsibility of the recovery service.",
    },
    {
      id: "sentinel",
      name: "Authorization",
      product: "SENTINEL",
      x: 848,
      y: 294,
      tone: neutralize(signed ? "observed" : "unknown"),
      status: stale
        ? "Observation stale"
        : signed
          ? "Signed receipt present"
          : sentinel?.configured === true
            ? "Policy configured"
            : "Policy not reported",
      fields: [
        ["Core policy configured", sentinel?.configured],
        ["Task policy configured", sentinel?.taskPolicyConfigured],
        ["Core nonce consumed", sentinel?.approvalsConsumed],
        ["Task nonce consumed", sentinel?.taskApprovalNonce],
      ],
      explanation:
        "Configured policy does not imply approval. Authorization requires the scoped, expiring signature and one-time nonce enforced by the protocol.",
    },
    {
      id: "rewind",
      name: "Escrow settlement",
      product: "REWIND",
      x: 600,
      y: 294,
      tone: neutralize(
        failed.length
          ? "failed"
          : pending.length
            ? "pending"
            : successful.length
              ? "observed"
              : "unknown",
      ),
      status: stale
        ? "Observation stale"
        : failed.length
          ? "Failed operation reported"
          : pending.length
            ? "Settlement pending"
            : successful.length
              ? "Succeeded operation observed"
              : "No finalized operation",
      fields: [
        ["Task", escrow?.taskId ?? escrow?.task_id],
        ["Available (yoctoNEAR)", escrow?.available],
        [
          "Reserved / pending (yoctoNEAR)",
          `${display(escrow?.reserved)} / ${display(escrow?.pending)}`,
        ],
        [
          "Succeeded operations",
          payments.length ? successful.length : undefined,
        ],
      ],
      explanation:
        "Only operations returned with Succeeded status count as finalized. Pending amounts remain reserved and are never represented as paid.",
    },
    {
      id: "proof",
      name: "Proof of recovery",
      product: "AUDITABLE EVIDENCE",
      x: 352,
      y: 294,
      tone: neutralize(receipt ? "observed" : "unknown"),
      status: stale
        ? "Observation stale"
        : signed
          ? "Signed evidence present"
          : receipt
            ? "Recovery record observed"
            : "Awaiting recovery receipt",
      fields: [
        ["Recovery epoch", receipt?.epoch_to ?? proof?.currentEpoch],
        ["Backup identity", receipt?.backup_identity],
        ["Checkpoint digest", receipt?.checkpoint_hash],
        ["Settlement operation", signedBody?.settlement_reference],
        ["Receipt source", proof?.status],
        ["Independent proof verification", "Not performed by this interface"],
      ],
      explanation:
        "An RPC observation, an attached signature, and an independently verified proof are different evidence levels. This interface does not claim independent cryptographic verification.",
    },
  ];
  const selectedStage = stages.find((stage) => stage.id === selected)!;
  const connections = [
    { from: "primary", to: "coordinator", d: "M146 116H290" },
    { from: "coordinator", to: "backup", d: "M414 116H558" },
    { from: "backup", to: "checkpoint", d: "M642 116H806" },
    { from: "checkpoint", to: "sentinel", d: "M848 158V252" },
    { from: "sentinel", to: "rewind", d: "M806 294H642" },
    { from: "rewind", to: "proof", d: "M558 294H394" },
  ];

  return (
    <section
      className="recovery-network"
      aria-labelledby={`${gradientId}-title`}
    >
      <div className="rn-heading">
        <div>
          <div className="rn-eyebrow">
            <span className="rn-mini-orbit" /> RECOVERY TOPOLOGY
          </div>
          <h2 id={`${gradientId}-title`}>Resilience, connected.</h2>
          <p>From the first heartbeat to accountable settlement.</p>
        </div>
        <div className="rn-mode" aria-label="Recovery data source">
          <button
            type="button"
            aria-pressed={!demoActive}
            onClick={() => setMode("observed")}
          >
            Contract state
          </button>
          <button
            type="button"
            aria-pressed={demoActive}
            onClick={() => setMode("demo")}
          >
            Sandbox events{events.length > 0 && <span>{events.length}</span>}
          </button>
        </div>
      </div>
      <div className="rn-source">
        <span
          className={`rn-source-dot ${!demoActive && hasObservation && !stale ? "rn-observed" : ""}`}
        />
        <span>
          {demoActive ? "LOCAL SANDBOX DEMONSTRATION · PROCESS EVENTS" : source}
        </span>
        <span className="rn-source-right">
          {demoActive
            ? `Run ${demoStatus}`
            : stale
              ? "Stale observation"
              : hasObservation
                ? "Select a node to inspect"
                : "Topology illustration · awaiting evidence"}
        </span>
      </div>
      {demoActive && (
        <div className="rn-event-picker">
          <label htmlFor={`${gradientId}-event`}>Inspect a sandbox event</label>
          <select
            id={`${gradientId}-event`}
            value={selectedEventId ?? ""}
            onChange={(event) => {
              const id = Number(event.target.value);
              setSelectedEventId(id);
              const match = events.find((item) => item.id === id);
              if (match && eventStages[match.kind])
                setSelected(eventStages[match.kind]);
            }}
          >
            <option value="">
              {events.length
                ? "Select a recorded event"
                : "No sandbox events recorded"}
            </option>
            {events.map((event) => (
              <option key={event.id} value={event.id}>
                #{event.id} · {event.kind.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <p>
            Process observations from the disposable sandbox. They do not change
            contract-state labels.
          </p>
        </div>
      )}
      <div
        className="rn-map-scroll"
        tabIndex={0}
        role="region"
        aria-label="Interactive recovery topology. Scroll horizontally on small screens."
      >
        <svg
          className="rn-map"
          viewBox="0 0 960 400"
          role="group"
          aria-label="Primary agent, recovery coordinator, backup, checkpoint, authorization, settlement and proof"
        >
          <defs>
            <linearGradient id={`${gradientId}-wire`}>
              <stop stopColor="var(--cerulean-glow)" stopOpacity=".3" />
              <stop offset=".5" stopColor="var(--rose-glow)" />
              <stop
                offset="1"
                stopColor="var(--cerulean-glow)"
                stopOpacity=".3"
              />
            </linearGradient>
            <radialGradient id={`${gradientId}-ambient`}>
              <stop stopColor="var(--rose-glow)" stopOpacity=".12" />
              <stop offset="1" stopColor="var(--rose-glow)" stopOpacity="0" />
            </radialGradient>
            <pattern
              id={`${gradientId}-grid`}
              width="24"
              height="24"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="1" cy="1" r=".7" fill="#93b4d6" opacity=".13" />
            </pattern>
          </defs>
          <rect width="960" height="400" fill={`url(#${gradientId}-grid)`} />
          <ellipse
            cx="352"
            cy="150"
            rx="300"
            ry="200"
            fill={`url(#${gradientId}-ambient)`}
          />
          <path
            d="M35 205H925M228 35V375M724 35V375"
            stroke="#9daecc"
            strokeOpacity=".045"
            strokeDasharray="3 7"
          />
          {connections.map((connection, index) => {
            const targetStage = stages.find(
              (stage) => stage.id === connection.to,
            )!;
            const highlighted = demoActive
              ? eventStage === connection.to || eventStage === connection.from
              : selected === connection.to || selected === connection.from;
            const observed = !demoActive && targetStage.tone === "observed";
            return (
              <g key={connection.d}>
                <path className="rn-path-bed" d={connection.d} />
                <motion.path
                  d={connection.d}
                  fill="none"
                  stroke={
                    highlighted
                      ? `url(#${gradientId}-wire)`
                      : observed
                        ? "var(--cerulean-glow)"
                        : "#41506a"
                  }
                  strokeWidth={highlighted ? 2 : 1.2}
                  strokeDasharray={observed ? undefined : "4 5"}
                  initial={false}
                  animate={{ opacity: highlighted ? 1 : 0.5, pathLength: 1 }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.45,
                    delay: reduceMotion ? 0 : index * 0.03,
                  }}
                />
                <circle
                  cx={
                    index < 3
                      ? [218, 486, 724][index]
                      : index === 3
                        ? 848
                        : index === 4
                          ? 724
                          : 476
                  }
                  cy={index < 3 ? 116 : index === 3 ? 205 : 294}
                  r="2.5"
                  fill={highlighted ? "var(--rose-glow)" : "#60708a"}
                />
                {index === 1 &&
                  backupPulse > 0 &&
                  rpcObservation &&
                  backup?.backupActive === true &&
                  !demoActive &&
                  !reduceMotion && (
                    <motion.circle
                      key={backupPulse}
                      className="rn-recovery-traveler"
                      r="3"
                      cy="116"
                      initial={{ cx: 414, opacity: 0 }}
                      animate={{ cx: 558, opacity: [0, 1, 0] }}
                      transition={{ duration: 0.82, ease: [0.22, 1, 0.36, 1] }}
                    />
                  )}
              </g>
            );
          })}
          {stages.map((stage, index) => {
            const active = selected === stage.id;
            const eventSelected = demoActive && eventStage === stage.id;
            const coordinator = stage.id === "coordinator";
            const titleStatus = demoActive
              ? eventSelected
                ? selectedEvent?.kind.replaceAll("_", " ")
                : "Sandbox process position"
              : stage.status;
            const heartbeatTitle =
              stage.id === "primary" ? `Heartbeat: ${heartbeat}. ` : "";
            const titleText = [
              `${stage.name}: ${titleStatus ?? ""}. `,
              heartbeatTitle,
              "Select to view evidence.",
            ].join("");
            return (
              <g
                key={stage.id}
                className={`rn-node rn-${demoActive ? "unknown" : stage.tone} ${active ? "rn-node-selected" : ""} ${eventSelected ? "rn-event-selected" : ""}`}
                transform={`translate(${stage.x} ${stage.y})`}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                aria-label={`${stage.name}: ${demoActive ? "Conceptual position" : stage.status}. Inspect details.`}
                onClick={() => setSelected(stage.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelected(stage.id);
                  }
                }}
              >
                <title>{titleText}</title>
                <circle
                  className="rn-focus-ring"
                  r={coordinator ? 62 : 44}
                  fill="none"
                />
                {coordinator && (
                  <>
                    <circle
                      r="62"
                      fill="none"
                      stroke="var(--rose-glow)"
                      strokeOpacity=".2"
                      strokeDasharray="2 6"
                    />
                    <circle
                      r="51"
                      fill="none"
                      stroke="var(--rose-glow)"
                      strokeOpacity=".14"
                    />
                  </>
                )}
                <motion.circle
                  className="rn-node-surface"
                  r={coordinator ? 43 : 33}
                  initial={false}
                  animate={{ scale: active && !reduceMotion ? 1.05 : 1 }}
                  transition={{
                    type: "spring",
                    stiffness: 250,
                    damping: 24,
                    duration: reduceMotion ? 0 : undefined,
                  }}
                />
                {stage.id === "checkpoint" &&
                  checkpointPulse > 0 &&
                  rpcObservation &&
                  !demoActive && (
                    <motion.g
                      key={checkpointPulse}
                      className="rn-checkpoint-confirmation"
                      initial={
                        reduceMotion ? false : { opacity: 0, scale: 0.86 }
                      }
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: reduceMotion ? 0 : 0.28 }}
                    >
                      <circle
                        r="40"
                        fill="none"
                        stroke="var(--cerulean-glow)"
                        strokeOpacity=".72"
                      />
                      <motion.path
                        d="M 17 -17 l 3 3 l 6 -7"
                        fill="none"
                        stroke="var(--cerulean-glow)"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        initial={reduceMotion ? false : { pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{
                          duration: reduceMotion ? 0 : 0.32,
                          delay: reduceMotion ? 0 : 0.08,
                        }}
                      />
                    </motion.g>
                  )}
                {stage.id === "primary" &&
                  heartbeat === "live" &&
                  !stale &&
                  !demoActive && (
                    <motion.circle
                      key={display(agent?.heartbeatAt ?? agent?.heartbeat_at)}
                      r="34"
                      fill="none"
                      stroke="var(--cerulean-glow)"
                      initial={
                        reduceMotion ? false : { opacity: 0.5, scale: 1 }
                      }
                      animate={{ opacity: 0, scale: 1.35 }}
                      transition={{ duration: reduceMotion ? 0 : 1.3 }}
                    />
                  )}
                {stage.id === "rewind" &&
                  settlementPulse &&
                  settledPaymentKeys.has(settlementPulse) &&
                  rpcObservation &&
                  !failed.length &&
                  !demoActive &&
                  !reduceMotion && (
                    <motion.circle
                      key={settlementPulse}
                      className="rn-settlement-pulse"
                      r="37"
                      fill="none"
                      stroke="var(--cerulean-glow)"
                      strokeWidth="1.5"
                      initial={{ opacity: 0.7, scale: 0.88 }}
                      animate={{ opacity: 0, scale: 1.28 }}
                      transition={{ duration: 0.72, ease: "easeOut" }}
                    />
                  )}
                {stage.id === "proof" && verifiedReceiptKey && !demoActive && (
                  <motion.g
                    key={`${verifiedReceiptKey}-${receiptArrivalKey === verifiedReceiptKey ? "arrived" : "settled"}`}
                    className="rn-receipt-arrival"
                    initial={
                      reduceMotion || receiptArrivalKey !== verifiedReceiptKey
                        ? false
                        : { opacity: 0, scale: 0.82 }
                    }
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.38,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    <circle
                      r="40"
                      fill="none"
                      stroke="var(--cerulean-glow)"
                      strokeOpacity=".68"
                    />
                    <path
                      d="m-8 0 5 5 11-12"
                      fill="none"
                      stroke="var(--cerulean-glow)"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </motion.g>
                )}
                <g className="rn-node-glyph">
                  <NodeGlyph id={stage.id} />
                </g>
                <circle
                  className="rn-node-status"
                  cx={coordinator ? 33 : 25}
                  cy={coordinator ? -29 : -24}
                  r="4"
                />
                <text
                  className="rn-node-number"
                  x={coordinator ? -55 : -42}
                  y={coordinator ? -47 : -34}
                >
                  {String(index + 1).padStart(2, "0")}
                </text>
                <text
                  className="rn-node-product"
                  y={coordinator ? 79 : 60}
                  textAnchor="middle"
                >
                  {stage.product}
                </text>
                <text
                  className="rn-node-name"
                  y={coordinator ? 98 : 79}
                  textAnchor="middle"
                >
                  {stage.name}
                </text>
                {eventSelected && (
                  <text className="rn-event-tag" y="-55" textAnchor="middle">
                    EVENT SELECTED
                  </text>
                )}
              </g>
            );
          })}
          <g transform="translate(64 280)" className="rn-map-note">
            <path
              d="M0 0h16M0 0v16M110 55H94M110 55V39"
              stroke="#53647c"
              fill="none"
            />
            <text x="10" y="24">
              ONE TASK.
            </text>
            <text x="10" y="41">
              FULL CONTINUITY.
            </text>
          </g>
        </svg>
      </div>
      <div className="rn-legend">
        <span>
          <i className="rn-legend-observed" />
          Observation present
        </span>
        <span>
          <i className="rn-legend-pending" />
          Pending
        </span>
        <span>
          <i className="rn-legend-failed" />
          Expired / failed / contained
        </span>
        <span>
          <i />
          Unknown
        </span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${selected}-${mode}-${selected === "rewind" ? selectedStage.status : selected === "proof" ? verifiedReceiptKey : ""}`}
          className="rn-detail"
          initial={reduceMotion ? false : { opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.16 }}
        >
          <div className="rn-detail-title">
            <span className="rn-detail-icon">
              <svg viewBox="-22 -22 44 44" aria-hidden="true">
                <NodeGlyph id={selected} />
              </svg>
            </span>
            <div>
              <span className="rn-eyebrow">
                {demoActive ? "SANDBOX EVENT INSPECTOR" : selectedStage.product}
              </span>
              <h3>{selectedStage.name}</h3>
            </div>
            <span
              className={`rn-state rn-${demoActive ? "unknown" : selectedStage.tone}`}
            >
              {demoActive
                ? eventStage === selected
                  ? "Process event"
                  : "Conceptual stage"
                : selectedStage.status}
            </span>
          </div>
          {demoActive ? (
            selectedEvent && eventStage === selected ? (
              <>
                <dl className="rn-fields">
                  <div>
                    <dt>Event</dt>
                    <dd>{selectedEvent.kind.replaceAll("_", " ")}</dd>
                  </div>
                  <div>
                    <dt>Process timestamp</dt>
                    <dd>{selectedEvent.at}</dd>
                  </div>
                  <div>
                    <dt>Run status</dt>
                    <dd>{demoStatus}</dd>
                  </div>
                </dl>
                <details className="rn-event-details">
                  <summary>Inspect reported event payload</summary>
                  <pre>{JSON.stringify(selectedEvent.details, null, 2)}</pre>
                </details>
                <p className="rn-detail-explanation">
                  This is a recorded local sandbox event, not proof of activity
                  on a public NEAR network.
                </p>
              </>
            ) : (
              <p className="rn-detail-explanation">
                {events.length
                  ? "Choose an event above to inspect its reported payload and highlight the corresponding stage."
                  : "Run the sandbox walkthrough to collect real process events. No demonstration events have been invented."}
              </p>
            )
          ) : (
            <>
              <motion.div
                key={
                  selected === "proof"
                    ? verifiedReceiptKey || "no-verified-receipt"
                    : selectedStage.status
                }
                initial={
                  reduceMotion || (selected === "proof" && !verifiedReceiptKey)
                    ? false
                    : { opacity: 0, y: 7 }
                }
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.24 }}
              >
                <dl className="rn-fields">
                  {selectedStage.fields.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd title={display(value)}>{display(value)}</dd>
                    </div>
                  ))}
                </dl>
                {selected === "proof" && verifiedReceiptKey && (
                  <p className="rn-receipt-confirmation" role="status">
                    <span aria-hidden="true">✓</span> SENTINEL verification
                    reported by the RPC contract view. The interface does not
                    independently verify receipt cryptography.
                  </p>
                )}
                {selected === "checkpoint" &&
                  checkpointPulse > 0 &&
                  rpcObservation &&
                  !demoActive && (
                    <p className="rn-checkpoint-status" role="status">
                      New STATEFLOW checkpoint commitment observed at sequence{" "}
                      {display(checkpoint?.sequence)}.
                    </p>
                  )}
                {selected === "backup" &&
                  backupPulse > 0 &&
                  rpcObservation &&
                  !demoActive && (
                    <p className="rn-checkpoint-status" role="status">
                      Backup activation observed for epoch{" "}
                      {display(agent?.generation)}.
                    </p>
                  )}
                {selected === "rewind" &&
                  settlementPulse &&
                  settledPaymentKeys.has(settlementPulse) &&
                  rpcObservation &&
                  !demoActive &&
                  !failed.length && (
                    <p className="rn-settlement-confirmation" role="status">
                      Settlement finalized in the returned contract view.
                    </p>
                  )}
                <p className="rn-detail-explanation">
                  {selectedStage.explanation}
                </p>
              </motion.div>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
