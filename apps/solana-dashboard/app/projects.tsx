"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatSol } from "./solana-rpc.mjs";
import { useWallet } from "./wallet";
import { fundingTransaction } from "./funding.mjs";

const api = "/api/production";
const roles: Record<string, string> = {manager:"PHOENIX AI Manager",research:"Research",design:"Design",developer:"Development",marketing:"Marketing",finance:"Finance",testing:"Testing"};
const states: Record<string, string> = {awaiting_funding:"Awaiting funding",running:"In progress",review:"Ready for review",held:"Held for review",approved:"Approved for settlement",settled:"Settled on Solana"};
const eventLabels: Record<string, string> = {project_submitted:"Project submitted",running:"Funding verified",agent_started:"Agent started",artifact_committed:"Artifact saved",retry_scheduled:"Retry scheduled",backup_started:"Backup attempt started",agent_failed:"Agent held",review:"Delivery ready",approved:"Customer approved delivery",settled:"Matching payout finalized",held:"Project placed on hold"};
type Project = {id:string;title:string;budget:string;state:string;created_at:number;requirements?:string;task_seed?:string;task?:string;wallet?:string;delivery_hash?:string;observed_slot?:number};
type Artifact = {file:string;content:string;sources:{url:string;title:string}[];files?:{path:string;content:string}[]};
type Job = {role:string;status:string;attempt:number;output:Artifact|null;error:string|null};
type ProjectDetail = {project:Project;jobs:Job[];events:{id:number;kind:string;role:string|null;happened_at:number}[]};
type List = {projects:Project[];chain:Record<string,string>|null;agentsConfigured:boolean};
type WalletAccount = NonNullable<ReturnType<typeof useWallet>["session"]>["accounts"][number];
type SendFeature = { signAndSendTransaction: (input:{account:WalletAccount;chain:"solana:mainnet";transaction:Uint8Array;options:{preflightCommitment:"confirmed"}}) => Promise<readonly {signature:Uint8Array}[]> };

class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function request<T>(route: string, body?: Record<string,string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(api + route, { signal, cache: "no-store", credentials: "same-origin",
    ...(body && { method:"POST", headers: { "content-type":"application/json" }, body:JSON.stringify(body) }) });
  if (response.status === 401) throw new RequestError("Sign in to open your project workspace.", 401);
  if (!response.headers.get("content-type")?.includes("application/json")) throw new RequestError("The production project service is unavailable.", 503);
  const data = await response.json();
  if (!response.ok) throw new RequestError(data.error || "The project request stopped unexpectedly.", response.status);
  return data;
}

function download(name: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], {type:"application/octet-stream"}));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ArtifactView({ artifact }: { artifact: Artifact }) {
  return <details className="project-artifact">
    <summary>{artifact.file}</summary>
    <pre>{artifact.content}</pre>
    {artifact.sources.length > 0 && <ul>{artifact.sources.map(source => <li key={source.url}><a className="text-link" href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul>}
    <div className="actions">
      <button className="button outline" type="button" onClick={() => download(artifact.file, artifact.content)}>Download artifact</button>
      {artifact.files?.map(file => <button className="button outline" key={file.path} type="button" onClick={() => download(file.path.split("/").at(-1) ?? "source.txt", file.content)}>{file.path}</button>)}
    </div>
  </details>;
}

export function ProjectsWorkspace() {
  const {session} = useWallet();
  const [list,setList] = useState<List|null>(null);
  const [detail,setDetail] = useState<ProjectDetail|null>(null);
  const [selected,setSelected] = useState("");
  const [signIn,setSignIn] = useState("");
  const [error,setError] = useState("");
  const [note,setNote] = useState("");
  const [busy,setBusy] = useState(false);
  const [task,setTask] = useState("");
  const [wallet,setWallet] = useState("");
  const [revision,setRevision] = useState(0);
  const draftId=useRef<string|null>(null);

  useEffect(() => {
    const controller=new AbortController();
    void request<List>("/projects",undefined,controller.signal).then(value => setList(value)).catch(cause => {
      if (controller.signal.aborted) return;
      if (cause instanceof RequestError && cause.status===401) {
        setSignIn("/signin-with-chatgpt?return_to="+encodeURIComponent(location.pathname));
        return;
      }
      setError(cause instanceof Error ? cause.message : "Project service unavailable.");
    });
    return () => controller.abort();
  },[revision]);

  useEffect(() => {
    if (!selected) return;
    const controller=new AbortController();
    let pending=false;
    async function refresh() {
      if (pending) return;
      pending=true;
      try {
        const value = await request<ProjectDetail>("/projects/"+selected,undefined,controller.signal);
        if (!controller.signal.aborted) setDetail(value);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Project update unavailable.");
      } finally { pending=false; }
    }
    void refresh();
    const timer=window.setInterval(() => void refresh(),5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  },[selected,revision]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    const fields=new FormData(form);
    setBusy(true);
    setError("");
    draftId.current ??= crypto.randomUUID();
    try {
      const created=await request<ProjectDetail>("/projects",{id:draftId.current,title:String(fields.get("title")),requirements:String(fields.get("requirements")),budgetSol:String(fields.get("budget"))});
      draftId.current=null;
      form.reset();
      setDetail(created);
      setSelected(created.project.id);
      setTask("");
      setWallet("");
      setRevision(n=>n+1);
    } catch(cause) { setError(cause instanceof Error ? cause.message : "The project could not be submitted."); }
    finally { setBusy(false); }
  }

  async function change(action: string, body: Record<string,string>) {
    setBusy(true);
    setError("");
    try { await request("/projects/"+selected+"/"+action,body); setRevision(n=>n+1); }
    catch(cause) { setError(cause instanceof Error ? cause.message : "The project could not be updated."); }
    finally { setBusy(false); }
  }

  async function fund(project: Project, chain: Record<string,string>) {
    if (!session || !project.task_seed) return;
    const account = session.accounts.find(item=>item.address===session.address);
    const feature = session.wallet.features["solana:signAndSendTransaction"] as SendFeature|undefined;
    if (!account || typeof feature?.signAndSendTransaction !== "function") {
      setError("Choose a Solana wallet that can sign and send transactions.");
      return;
    }
    setBusy(true);
    setError("");
    setNote("");
    try {
      const signed = await fundingTransaction(chain, account.address, project.task_seed, project.budget, new AbortController().signal);
      const [receipt] = await feature.signAndSendTransaction({account,chain:"solana:mainnet",transaction:signed.transaction,options:{preflightCommitment:"confirmed"}});
      if (receipt?.signature?.length !== 64) throw new Error("The wallet did not return a transaction signature.");
      setTask(signed.task);
      setWallet(account.address);
      setNote("Funding was submitted. Select Verify finalized funding when Solana confirms the task.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The wallet did not submit funding."); }
    finally { setBusy(false); }
  }

  if (signIn) return <section className="panel"><h2>Your projects</h2><p>Sign in to submit requirements and review your deliveries.</p><a className="button primary" href={signIn} target="_top">Sign in</a></section>;
  if (!list) return <div className="panel" role="status">{error || "Loading your project workspace…"}</div>;
  const project=detail?.project.id===selected ? detail.project : undefined;
  const configured=Boolean(list.chain && list.agentsConfigured);

  return <div className="projects-workspace">
    {error && <p className="panel warning-text" role="alert">{error}</p>}
    <div className="console-grid">
      <form className="panel account-form" onSubmit={(event)=>void create(event)}>
        <h2>Submit a project</h2>
        <label>Project title<input name="title" minLength={3} maxLength={120} required /></label>
        <label>Requirements<textarea name="requirements" minLength={20} maxLength={12000} rows={6} required /></label>
        <label>Budget in SOL<input name="budget" inputMode="decimal" placeholder="0.00" required /></label>
        <button type="submit" className="button primary" disabled={busy}>Save project brief</button>
      </form>
      <section className="panel">
        <h2>Your projects</h2>
        {list.projects.length === 0 && <p>Submit a brief to create your first project.</p>}
        <ul className="project-list">{list.projects.map(item=><li key={item.id}>
          <button type="button" disabled={busy} aria-pressed={selected===item.id} onClick={()=>{if(selected===item.id)return;setSelected(item.id);setDetail(null);setTask("");setWallet("");setError("");setNote("");}}>
            <strong>{item.title}</strong><span>{states[item.state]} · {formatSol(item.budget)} SOL</span>
          </button>
        </li>)}</ul>
      </section>
    </div>
    {selected && !project && <p role="status">Loading the project…</p>}
    {project && detail && <>
      <section className="panel project-detail">
        <div className="panel-heading"><h2>{project.title}</h2><span className="tag">{states[project.state]}</span></div>
        <p className="project-brief">{project.requirements}</p>
        <p>Budget <strong>{formatSol(project.budget)} SOL</strong>{project.observed_slot ? <> · Finalized slot {project.observed_slot.toLocaleString()}</> : null}</p>
        {project.state === "awaiting_funding" && (configured ?
          <form className="account-form" onSubmit={event=>{event.preventDefault();void change("funding",{task:task.trim(),wallet:wallet.trim()||session?.address||""});}}>
            <p>Fund {formatSol(project.budget)} SOL plus Solana rent and fees, or link the project’s already funded account.</p>
            {session && list.chain && <button type="button" className="button outline" disabled={busy||!!task} onClick={()=>void fund(project,list.chain!)}>Fund in connected wallet</button>}
            {note && <p role="status">{note}</p>}
            <details><summary>Solana funding parameters</summary><dl>
              <div className="data-row"><dt>Project seed</dt><dd>{project.task_seed}</dd></div>
              <div className="data-row"><dt>Budget in lamports</dt><dd>{project.budget}</dd></div>
              {Object.entries(list.chain || {}).map(([name,address])=><div className="data-row" key={name}><dt>{name}</dt><dd>{address}</dd></div>)}
            </dl></details>
            <label>Task account<input value={task} onChange={e=>setTask(e.target.value)} autoComplete="off" required /></label>
            <label>Funding wallet<input value={wallet || session?.address || ""} onChange={e=>setWallet(e.target.value)} autoComplete="off" required /></label>
            <button type="submit" className="button primary" disabled={busy}>Verify finalized funding</button>
          </form> : <p role="status">Funding opens once the AI service and Solana mainnet authorities are configured.</p>)}
        {project.delivery_hash && <><p>Delivery checkpoint</p><code className="recovery-digest">{project.delivery_hash}</code></>}
        {project.state === "review" && <button className="button primary" type="button" disabled={busy} onClick={()=>void change("approve",{digest:project.delivery_hash||""})}>Approve this delivery</button>}
        {project.state === "approved" && <div className="actions">
          <button className="button outline" type="button" onClick={()=>download(`phoenix-approval-${project.id}.json`,JSON.stringify({
            id:project.id,state:project.state,task_seed:project.task_seed,task:project.task,wallet:project.wallet,
            budget:project.budget,delivery_hash:project.delivery_hash,
          },null,2))}>Download settlement approval</button>
          <button className="button primary" type="button" disabled={busy} onClick={()=>void change("settlement",{})}>Verify finalized settlement</button>
        </div>}
      </section>
      <section className="panel"><h2>Agent work and delivery</h2>
        {detail.jobs.map(job=><div className="project-job" key={job.role}>
          <div className="panel-heading"><h3>{roles[job.role] || job.role}</h3><span className="tag">{job.status}{job.attempt > 1 ? ` · Attempt ${job.attempt}` : ""}</span></div>
          {job.error && <p>{job.error}</p>}
          {job.output && <ArtifactView artifact={job.output} />}
        </div>)}
      </section>
      <section className="panel"><h2>Guardian activity</h2><ol className="project-activity">
        {detail.events.map(item=><li key={item.id}><time dateTime={new Date(item.happened_at*1000).toISOString()}>{new Date(item.happened_at*1000).toLocaleString()}</time><span>{eventLabels[item.kind] || item.kind}{item.role && ` · ${roles[item.role] || item.role}`}</span></li>)}
      </ol></section>
    </>}
  </div>;
}
