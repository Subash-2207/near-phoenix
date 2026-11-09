"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, MagneticButton } from "./ui";
import { useMotionPreferences } from "./motion-preferences";
import "./monolith-overview.css";

type Evidence = Record<string, unknown>;
type Props = {
  agent: Evidence; checkpoint: Evidence; sentinel: Evidence; escrow: Evidence; backup: Evidence;
  hasSource: boolean; stale: boolean; source: string; observed: string; sourceError: string;
  onNavigate: (id: string) => void; onRefresh: () => Promise<void>; children: ReactNode;
};
const stages = [
  { id: "detect", label: "Detect", description: "Observe the primary agent’s heartbeat against chain time. An expired heartbeat opens the recovery path; it does not authorize an action.", route: "recovery", action: "Inspect detection evidence" },
  { id: "verify", label: "Verify", description: "Confirm recovery conditions, validate the signed checkpoint, and obtain independent authorization before proceeding to restore.", route: "sentinel", action: "Inspect authorization evidence" },
  { id: "restore", label: "Restore", description: "Resume from a committed checkpoint with an authorized backup. Fenced recovery epochs keep stale workers from continuing the task.", route: "recovery", action: "Inspect restoration evidence" },
  { id: "settle", label: "Settle", description: "Inspect task budgets, approvals and the final transfer callback. Pending or uncertain transfers remain unsettled until their outcome is known.", route: "escrow", action: "Inspect settlement evidence" },
] as const;
function valueText(value: unknown) {
  if (value === undefined || value === null || value === "") return "Awaiting telemetry";
  if (typeof value === "boolean") return value ? "Reported" : "Not reported";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
export function MonolithOverview(props: Props) {
  const { agent, checkpoint, sentinel, escrow, backup, hasSource, stale, source, observed, sourceError, onNavigate, onRefresh, children } = props;
  const [selected, setSelected] = useState(1);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const searchDialog = useRef<HTMLDialogElement>(null);
  const sourceTrigger = useRef<HTMLElement | null>(null);
  const searchTrigger = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const stageRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hero = useRef<HTMLElement>(null);
  const { openPreferences, reduceMotion } = useMotionPreferences();
  const stage = stages[selected];
  const records = [
    { label: "Agent identity", value: agent.id, group: "Recovery", route: "recovery" },
    { label: "Agent status", value: agent.status, group: "Recovery", route: "recovery" },
    { label: "Recovery epoch", value: agent.generation, group: "Recovery", route: "recovery" },
    { label: "Checkpoint digest", value: checkpoint.digest, group: "STATEFLOW", route: "recovery" },
    { label: "Checkpoint sequence", value: checkpoint.sequence, group: "STATEFLOW", route: "recovery" },
    { label: "Active worker", value: backup.currentWorker, group: "Recovery", route: "recovery" },
    { label: "Task policy", value: sentinel.taskPolicyConfigured, group: "SENTINEL", route: "sentinel" },
    { label: "Approval nonce", value: sentinel.taskApprovalNonce, group: "SENTINEL", route: "sentinel" },
    { label: "Task ID", value: escrow.taskId, group: "REWIND", route: "escrow" },
    { label: "Available escrow (yoctoNEAR)", value: escrow.available, group: "REWIND", route: "escrow" },
  ];
  const filtered = records.filter((item) => `${item.label} ${item.group} ${valueText(item.value)}`.toLowerCase().includes(search.trim().toLowerCase()));
  const fields = selected === 0 ? [["Agent status", agent.status], ["Recovery epoch", agent.generation]]
    : selected === 1 ? [["Checkpoint", checkpoint.digest ?? checkpoint.sequence], ["Independent authorization", hasSource ? "Inspect SENTINEL evidence" : undefined]]
    : selected === 2 ? [["Active worker", backup.currentWorker], ["Recovery epoch", agent.generation]]
    : [["Task ID", escrow.taskId], ["Available (yoctoNEAR)", escrow.available]];
  useEffect(() => {
    const element = hero.current;
    const fine = matchMedia("(hover: hover) and (pointer: fine)");
    if (!element || reduceMotion || !fine.matches) return;
    let frame = 0; let px = 0; let py = 0;
    const reset = () => { cancelAnimationFrame(frame); frame = 0; element.style.removeProperty("--art-x"); element.style.removeProperty("--art-y"); };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || document.hidden || !fine.matches) return;
      const rect = element.getBoundingClientRect();
      px = (event.clientX - rect.left - rect.width / 2) / rect.width * 8;
      py = (event.clientY - rect.top - rect.height / 2) / rect.height * 6;
      if (!frame) frame = requestAnimationFrame(() => { element.style.setProperty("--art-x", `${px}px`); element.style.setProperty("--art-y", `${py}px`); frame = 0; });
    };
    element.addEventListener("pointermove", move, { passive: true });
    element.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    fine.addEventListener("change", reset);
    return () => { reset(); element.removeEventListener("pointermove", move); element.removeEventListener("pointerleave", reset); window.removeEventListener("blur", reset); document.removeEventListener("visibilitychange", reset); fine.removeEventListener("change", reset); };
  }, [reduceMotion]);
  const openSource = () => { sourceTrigger.current = document.activeElement as HTMLElement; setRefreshMessage(""); sourceDialog.current?.showModal(); };
  const openSearch = () => { searchTrigger.current = document.activeElement as HTMLElement; setSearch(""); searchDialog.current?.showModal(); searchInput.current?.focus(); };
  return (
    <div className="mn-overview">
      <div className="mn-stage">
        <section className="mn-hero" ref={hero} aria-labelledby="mn-title">
          <div className="mn-art-frame" aria-hidden="true"><img className="mn-art" src="/images/phoenix-silver.png" alt="" width="1374" height="1145" fetchPriority="high" /></div>
          <div className="mn-hero-copy">
            <p className="mn-eyebrow"><span /> Autonomous continuity</p>
            <h1 id="mn-title">Built to<br /><span>begin again.</span></h1>
            <p className="mn-hero-description">Recovery, security and verifiable<br className="mn-desktop-break" /> execution. One clear workspace.</p>
            <div className="mn-hero-actions"><MagneticButton className="mn-primary" href="/recovery">Explore recovery <Icon name="arrow" size={20} /></MagneticButton><a className="mn-quiet-link" href="/methodology">How it works</a></div>
          </div>
          <span className="mn-art-caption"><Icon name="sentinel" size={15} /> Concept visualization</span>
        </section>
        <section className="mn-briefing" aria-labelledby="mn-briefing-title">
          <p className="mn-eyebrow"><span /> Recovery briefing</p>
          <h2 id="mn-briefing-title">Your next step.</h2>
          <p className="mn-briefing-intro">{stale ? "The last observation is out of date. Refresh your source before reviewing evidence." : hasSource ? "Explore the returned observations and follow the evidence through each recovery stage." : "Connect a telemetry source to inspect recovery evidence."}</p>
          <button className="mn-primary mn-source-button" onClick={openSource}>Open source details <Icon name="external" size={17} /></button>
          <div className="mn-steps" role="tablist" aria-label="Recovery stages">
            {stages.map((item, index) => <button key={item.id} ref={(node) => { stageRefs.current[index] = node; }} id={`mn-stage-${item.id}`} role="tab" aria-selected={index === selected} aria-controls="mn-stage-panel" tabIndex={index === selected ? 0 : -1} className={index === selected ? "is-active" : ""} onClick={() => setSelected(index)} onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % stages.length;
              else if (event.key === "ArrowLeft") next = (index + stages.length - 1) % stages.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = stages.length - 1;
              else return;
              event.preventDefault(); setSelected(next); stageRefs.current[next]?.focus();
            }}><span className="mn-step-marker" /><span>{item.label}</span></button>)}
          </div>
          <div id="mn-stage-panel" className="mn-step-detail" role="tabpanel" aria-labelledby={`mn-stage-${stage.id}`} tabIndex={0}>
            <span className="mn-concept-label">Recovery guide</span><h3>{stage.label}</h3><p>{stage.description}</p>
            <dl className="mn-evidence-fields">{fields.map(([label, value]) => <div key={String(label)}><dt>{String(label)}</dt><dd title={valueText(value)}>{valueText(value)}</dd></div>)}</dl>
            <button className="mn-inspect" onClick={() => onNavigate(stage.route)}>{stage.action} <Icon name="arrow" size={16} /></button>
          </div>
        </section>
      </div>
      <section className="mn-tools" aria-labelledby="mn-tools-title">
        <h2 id="mn-tools-title">Workspace tools</h2>
        <button className="mn-tool" onClick={openSearch}><span className="mn-tool-icon"><Icon name="search" size={25} /></span><span><strong>Search evidence</strong><small>Find and review recovery evidence in this workspace.</small></span><Icon name="arrow" size={18} /></button>
        <button className="mn-tool" onClick={openPreferences}><span className="mn-tool-icon"><Icon name="activity" size={25} /></span><span><strong>Motion preferences</strong><small>Adjust background motion and visual intensity.</small></span><Icon name="arrow" size={18} /></button>
      </section>
      <div className="mn-statusline"><span><b>PHOENIX — Monolith Studio</b><span>Read-only workspace</span></span><button onClick={openSource}><span className={`mn-source-dot ${hasSource && !stale ? "is-ready" : ""}`} />{stale ? "Observation is stale" : hasSource ? "Contract source available" : "Awaiting telemetry"}<Icon name="external" size={13} /></button></div>
      <details className="mn-telemetry"><summary><span><Icon name="analytics" size={18} /> Telemetry overview</span><span>Metrics, topology & system evidence <Icon name="arrow" size={15} /></span></summary><div className="mn-telemetry-content">{children}</div></details>
      <dialog ref={sourceDialog} className="mn-dialog" aria-labelledby="mn-source-title" onClose={() => sourceTrigger.current?.focus()} onClick={(event) => { if (event.target === event.currentTarget) sourceDialog.current?.close(); }}>
        <div className="mn-dialog-content">
          <div className="mn-dialog-heading"><div><p className="mn-eyebrow">Workspace connection</p><h2 id="mn-source-title">Source details</h2></div><button className="mn-close" aria-label="Close source details" onClick={() => sourceDialog.current?.close()}><Icon name="close" /></button></div>
          <p>{hasSource ? "These are read-only observations from the configured source. Inspect the corresponding evidence before drawing conclusions." : "The interface is ready. Connect the local Control Plane or configure contract views in Developers to populate live observations."}</p>
          <dl className="mn-source-fields"><div><dt>Source</dt><dd>{source}</dd></div><div><dt>Last observation</dt><dd>{observed}</dd></div><div><dt>Availability</dt><dd>{stale ? "Stale snapshot" : hasSource ? "Observation returned" : "Not configured"}</dd></div></dl>
          {sourceError && <p className="mn-source-note">{sourceError}</p>}
          <div className="mn-dialog-actions"><button className="mn-primary" onClick={() => { sourceDialog.current?.close(); onNavigate("developers"); }}>Open Developers <Icon name="arrow" size={16} /></button><button className="mn-secondary" disabled={refreshing} onClick={async () => { setRefreshing(true); setRefreshMessage(""); try { await onRefresh(); setRefreshMessage("Source check complete. Availability is shown above."); } catch { setRefreshMessage("Source check failed. Please try again."); } finally { setRefreshing(false); } }}><Icon name="refresh" size={16} />{refreshing ? "Refreshing…" : "Refresh source"}</button></div>
          <p className="mn-live-message" role="status">{refreshMessage}</p>
        </div>
      </dialog>
      <dialog ref={searchDialog} className="mn-dialog mn-search-dialog" aria-labelledby="mn-search-title" onClose={() => searchTrigger.current?.focus()} onClick={(event) => { if (event.target === event.currentTarget) searchDialog.current?.close(); }}>
        <div className="mn-dialog-content">
          <div className="mn-dialog-heading"><div><p className="mn-eyebrow">Current observation</p><h2 id="mn-search-title">Search evidence</h2></div><button className="mn-close" aria-label="Close evidence search" onClick={() => searchDialog.current?.close()}><Icon name="close" /></button></div>
          <label className="mn-search-input"><Icon name="search" /><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search checkpoint, agent, escrow…" aria-label="Search current evidence" /></label>
          <p className="mn-search-count" role="status">{filtered.length} {filtered.length === 1 ? "field" : "fields"} found{!hasSource ? " · Awaiting a telemetry source" : stale ? " · Stale snapshot" : ""}</p>
          <div className="mn-search-results">{filtered.length ? filtered.map((item) => <button key={item.label} onClick={() => { searchDialog.current?.close(); onNavigate(item.route); }}><span><small>{item.group}</small><strong>{item.label}</strong><span title={valueText(item.value)}>{valueText(item.value)}</span></span><Icon name="arrow" /></button>) : <p className="mn-search-empty">No matching evidence fields. Try “checkpoint”, “agent” or “escrow”.</p>}</div>
        </div>
      </dialog>
    </div>
  );
}
