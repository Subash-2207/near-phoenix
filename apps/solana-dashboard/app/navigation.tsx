"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { ConnectWalletButton } from "./wallet";

const primary = [
  { label: "Overview", href: "/" },
  { label: "Projects", href: "/projects" },
  { label: "Recovery", href: "/recovery" },
  { label: "Security", href: "/security" },
  { label: "Escrow", href: "/escrow" },
  { label: "Whitepaper", href: "/whitepaper" },
] as const;

const workspace = [
  { label: "Sentinel approvals", href: "/sentinel" },
  { label: "Recovery evidence", href: "/evidence" },
  { label: "Task explorer", href: "/explorer" },
  { label: "Recovery activity", href: "/analytics" },
  { label: "Developers", href: "/developers" },
  { label: "Solana wallet", href: "/wallet" },
  { label: "About", href: "/about" },
] as const;

export function Header() {
  const path = usePathname().replace(/\/$/, "") || "/";
  const menu = useRef<HTMLDialogElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);

  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="wordmark" href="/" aria-label="PHOENIX overview">
          <svg className="flame-mark" viewBox="0 0 42 42" aria-hidden="true">
            <path d="m21 11 5-7-2 12 15-7-10 15 8-4-12 15-4 5-4-5L5 20l8 4L3 9l15 7-2-12 5 7Z" fill="currentColor" />
            <path d="m13 20 8 7 8-7-8 3-8-3Z" fill="var(--bg)" />
          </svg>
          <span>PHOENIX</span>
        </Link>
        <nav className="primary-nav" aria-label="Primary navigation">
          {primary.map(({ label, href }) => (
            <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>{label}</Link>
          ))}
        </nav>
        <div className="header-actions">
          <button type="button" ref={menuTrigger} className="menu-trigger" aria-haspopup="dialog" onClick={() => menu.current?.showModal()}>
            <span className="desktop-menu-label">More</span><span className="mobile-menu-label">Menu</span>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h12M2 8h12M2 11h12" fill="none" stroke="currentColor" strokeLinecap="round" /></svg>
          </button>
          <ConnectWalletButton className="button header-cta" />
        </div>
      </div>
      <dialog className="workspace-menu" ref={menu} aria-labelledby="workspace-menu-title" onClose={() => menuTrigger.current?.focus()} onClick={(event) => { if (event.target === event.currentTarget) menu.current?.close(); }}>
        <div className="workspace-menu-content">
          <div className="workspace-menu-heading">
            <h2 id="workspace-menu-title">Workspace navigation</h2>
            <button type="button" className="menu-trigger" onClick={() => menu.current?.close()}>Close</button>
          </div>
          <nav aria-label="All workspace pages">
            {[...primary, ...workspace].map(({ label, href }) => (
              <Link key={href} href={href} aria-current={path === href ? "page" : undefined} onClick={() => menu.current?.close()}>{label}</Link>
            ))}
          </nav>
        </div>
      </dialog>
    </header>
  );
}
