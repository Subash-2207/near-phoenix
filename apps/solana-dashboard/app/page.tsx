import Link from "next/link";

const features = [
  { title: "Agent recovery", body: "Resume a failed task from a committed checkpoint. A new execution generation fences out stale workers.", href: "/recovery" },
  { title: "Security controls", body: "Quarantine a task and require independent approval before a backup can resume it.", href: "/security" },
  { title: "SOL escrow", body: "Track task funding, approved payouts and refunds in lamports.", href: "/escrow" },
  { title: "Recovery evidence", body: "Inspect the slot, generation and checkpoint hash recorded by the program.", href: "/evidence" },
];

const specialists = ["Research", "Design", "Development", "Marketing", "Finance", "Testing"];

const recoveryGuide = [
  { title: "Detect a missed heartbeat", description: "The recovery window opens when a worker stops reporting progress. Its last committed checkpoint stays available." },
  { title: "Verify the checkpoint and approval", description: "Sentinel authorizes recovery independently. A quarantined task stays blocked until the required review clears it." },
  { title: "Restore under a new generation", description: "The backup resumes from the checkpoint under a new generation. A late message from the original worker belongs to the old generation." },
  { title: "Settle the approved amount", description: "An approved payout updates the task’s SOL escrow. Each settlement uses a nonce to guard against a repeated payout." },
];

export default function Home() {
  return <div className="overview-page">
    <section className="studio-stage" aria-labelledby="studio-title">
      <div className="hero">
        <div className="hero-copy">
          <p className="kicker"><span /> Autonomous continuity on Solana</p>
          <h1 id="studio-title">Built to<br /><em>begin again.</em></h1>
        <p className="hero-description">An AI team to plan and deliver your project, with recovery controls and Solana escrow.</p>
          <div className="actions">
            <Link className="button primary" href="/projects">Open project workspace</Link>
            <Link className="quiet-link" href="/whitepaper">Read the whitepaper</Link>
          </div>
        </div>
        <span className="art-caption">Concept visualization</span>
      </div>
      <aside className="hero-trace" aria-labelledby="briefing-title">
        <p className="kicker"><span /> Project workflow</p>
        <h2 id="briefing-title">From brief to delivery.</h2>
        <p className="briefing-intro">Submit requirements and a budget. The PHOENIX manager breaks the work into assignments for six specialists.</p>
        <ul className="overview-specialists" aria-label="Specialist agents">{specialists.map(name => <li key={name}>{name}</li>)}</ul>
        <h3 className="trace-title">Customer review</h3>
        <p className="briefing-intro">Inspect the deliverables, Guardian activity, and finalized escrow before approving payment.</p>
      </aside>
    </section>
    <section className="product-section" aria-labelledby="tools">
      <div className="section-lead">
        <h2 id="tools">Workspace tools</h2>
      </div>
      <div className="feature-grid">
        {features.map((feature) => (
          <Link key={feature.href} className="feature" href={feature.href}>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </Link>
        ))}
      </div>
    </section>
    <section className="overview-section overview-guide" aria-labelledby="guide-title">
      <div className="wrap overview-split">
        <div className="overview-copy">
          <p className="kicker"><span /> Recovery lifecycle</p>
          <h2 id="guide-title">From missed heartbeat to restored work.</h2>
          <p>Follow one task through detection, independent approval, backup recovery, and settlement in the recovery console.</p>
          <Link className="button primary" href="/recovery">Inspect recovery</Link>
        </div>
        <ol className="overview-steps">
          {recoveryGuide.map(({ title, description }) => (
            <li key={title}><span aria-hidden="true" /><div><h3>{title}</h3><p>{description}</p></div></li>
          ))}
        </ol>
      </div>
    </section>
    <section className="overview-section overview-evidence" aria-labelledby="overview-evidence-title">
      <div className="wrap overview-split">
        <div className="overview-copy">
          <p className="kicker"><span /> Evidence and escrow</p>
          <h2 id="overview-evidence-title">See what the recovery recorded.</h2>
          <p>Inspect the execution generation, checkpoint digest, and remaining escrow. For a configured PHOENIX deployment, the task explorer reads a finalized Solana account.</p>
          <div className="actions">
            <Link className="button primary" href="/explorer">Open task explorer</Link>
            <Link className="button outline" href="/whitepaper">Read the whitepaper</Link>
          </div>
        </div>
        <div className="panel overview-example">
          <h3>Delivery evidence</h3>
          <p>The workspace records each completed artifact and the customer-approved delivery digest. It reconciles settlement against the finalized Solana task.</p>
          <Link className="text-link" href="/projects">Open project workspace</Link>
        </div>
      </div>
    </section>
  </div>;
}
