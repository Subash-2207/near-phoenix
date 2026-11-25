import Link from "next/link";
import { notFound } from "next/navigation";
import { Console, type ConsoleMode } from "../console";
import { WalletWorkspace } from "../wallet";
import { Whitepaper } from "../whitepaper";
import { ProjectsWorkspace } from "../projects";

const sections: Record<string, { title: string; description: string; mode?: ConsoleMode }> = {
  projects: { title: "Project workspace", description: "Submit a brief, review your agents’ deliverables, and approve the finished work." },
  recovery: { title: "Recovery workspace", description: "Track checkpoints, execution generations and worker recovery.", mode: "recovery" },
  security: { title: "Security controls", description: "Review quarantine and Sentinel approvals.", mode: "security" },
  sentinel: { title: "Sentinel approvals", description: "Review the authorization window for recovery and payouts.", mode: "security" },
  escrow: { title: "SOL escrow", description: "Inspect funded balances, approved payouts and refunds.", mode: "escrow" },
  evidence: { title: "Recovery evidence", description: "Inspect the recorded slot, generation and checkpoint digest.", mode: "evidence" },
  explorer: { title: "Task explorer", description: "Read a finalized PHOENIX task account from Solana.", mode: "evidence" },
  analytics: { title: "Recovery activity", description: "Review activity counts from the selected task.", mode: "evidence" },
  "token-economics": { title: "SOL escrow", description: "Escrow funds, payouts and refunds are recorded in lamports.", mode: "escrow" },
  developers: { title: "Developer workspace", description: "Inspect a task account and its recovery evidence.", mode: "evidence" },
  methodology: { title: "PHOENIX whitepaper", description: "Architecture, verification and trust boundaries." },
  whitepaper: { title: "PHOENIX whitepaper", description: "Architecture, verification and trust boundaries." },
  about: { title: "About PHOENIX", description: "Recovery infrastructure for autonomous agents on Solana." },
  wallet: { title: "Solana wallet", description: "Connect a compatible wallet and inspect its finalized mainnet balance." },
  solana: { title: "Solana wallet", description: "Connect a compatible wallet and inspect its finalized mainnet balance." },
};

export const dynamicParams = false;
export function generateStaticParams() { return Object.keys(sections).map(section => ({ section })); }
export async function generateMetadata({params}: {params: Promise<{section: string}>}) {
  const {section} = await params;
  return {title: sections[section]?.title};
}

const menu = [
  ["Recovery", "recovery"], ["Security", "security"], ["Escrow", "escrow"],
  ["Evidence", "evidence"], ["Task explorer", "explorer"], ["Wallet", "wallet"],
];
export default async function Section({params}: {params: Promise<{section: string}>}) {
  const {section} = await params;
  const page = sections[section];
  if (!page) notFound();
  return <div className="wrap inner-page" data-section={section}>
    <div className="page-heading">
      <p className="kicker"><span /> PHOENIX <span className="kicker-divider" /> SOLANA</p>
      <h1>{page.title}</h1><p>{page.description}</p>
    </div>
    {(page.mode || section === "wallet" || section === "solana") && <nav className="console-nav" aria-label="Console navigation">
      {menu.map(([title, key]) => <Link key={key} href={"/" + key} aria-current={section === key ? "page" : undefined}>{title}</Link>)}
    </nav>}
    {section === "projects" ? <ProjectsWorkspace /> : page.mode ? <Console key={page.mode + section} mode={page.mode} /> :
      section === "wallet" || section === "solana" ? <WalletWorkspace /> : <Whitepaper />}
  </div>;
}
