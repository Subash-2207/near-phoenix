"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { sectionHref, type DashboardSection } from "../sections";
import { AmbientCursor, Icon } from "./ui";
import { MotionPreferencesButton } from "./motion-preferences";
import { ThemeSwitcher } from "./theme-switcher";
import "./command-shell.css";

export const destinations: Array<{ id: DashboardSection; label: string; group?: string }> = [
  { id: "overview", label: "Overview", group: "COMMAND CENTER" },
  { id: "recovery", label: "Recovery Network" },
  { id: "security", label: "Security / GUARDIAN" },
  { id: "escrow", label: "Escrow / REWIND" },
  { id: "sentinel", label: "SENTINEL" },
  { id: "explorer", label: "Blockchain Explorer", group: "INTELLIGENCE" },
  { id: "analytics", label: "Analytics" },
  { id: "token-economics", label: "Token Economics" },
  { id: "methodology", label: "Methodology & Data", group: "RESOURCES" },
  { id: "developers", label: "Developers" },
  { id: "about", label: "About" },
];
const primaryDestinations = [
  { id: "overview", label: "Overview" },
  { id: "recovery", label: "Recovery" },
  { id: "security", label: "Security" },
  { id: "escrow", label: "Escrow" },
] as const;

type CommandShellProps = {
  active: string;
  onNavigate: (id: string) => void;
  children: ReactNode;
  networkLabel: string;
  rpcHealthy: boolean;
  notificationCount: number;
  walletLabel: string;
  onWallet: () => void;
  walletDisabled: boolean;
};

function PhoenixMark() {
  return (
    <svg className="px-brand-symbol" viewBox="0 0 42 42" fill="none" aria-hidden="true">
      <path d="m21 11 5-7-2 12 15-7-10 15 8-4-12 15-4 5-4-5L5 20l8 4L3 9l15 7-2-12 5 7Z" fill="currentColor" />
      <path d="m13 20 8 7 8-7-8 3-8-3Z" fill="var(--shell-bg)" />
    </svg>
  );
}

export function CommandShell({ active, onNavigate, children, networkLabel, rpcHealthy, notificationCount, walletLabel, onWallet, walletDisabled }: CommandShellProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [shortcut, setShortcut] = useState("Ctrl K");
  const paletteRef = useRef<HTMLDialogElement>(null);
  const mobileRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const navigationTriggerRef = useRef<HTMLElement | null>(null);
  const results = destinations.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  const title = destinations.find((item) => item.id === active)?.label ?? "Overview";

  const openPalette = useCallback(() => {
    if (paletteRef.current?.open) return;
    const trigger = document.activeElement as HTMLElement | null;
    if (mobileRef.current?.open) mobileRef.current.close();
    triggerRef.current = trigger;
    setQuery("");
    setSelected(0);
    paletteRef.current?.showModal();
    searchRef.current?.focus();
  }, []);
  const closePalette = () => paletteRef.current?.close();
  const openNavigation = (event: MouseEvent<HTMLButtonElement>) => {
    navigationTriggerRef.current = event.currentTarget;
    if (!mobileRef.current?.open) mobileRef.current?.showModal();
  };
  const navigate = (id: string) => {
    if (paletteRef.current?.open) paletteRef.current.close();
    if (mobileRef.current?.open) mobileRef.current.close();
    onNavigate(id);
  };
  const onLink = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(id);
  };

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setShortcut("⌘ K");
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (paletteRef.current?.open) paletteRef.current.close();
        else openPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("phoenix:open-command", openPalette);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("phoenix:open-command", openPalette);
    };
  }, [openPalette]);
  useEffect(() => {
    if (paletteRef.current?.open) document.getElementById(`px-command-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const brand = <><PhoenixMark /><span className="px-brand-name">PHOENIX</span></>;
  return (
    <div className="px-shell px-monolith" data-section={active}>
      <AmbientCursor />
      <a className="px-skip" href="#command-content">Skip to main content</a>
      <div className="px-workspace">
        <header className="px-topbar">
          <a className="px-brand" href="/near-phoenix/" onClick={(event) => onLink(event, "overview")} aria-label="PHOENIX overview">{brand}</a>
          <div className="px-studio-name">Monolith Studio<span>NEAR PHOENIX v5.0</span></div>
          <nav className="px-horizontal-nav" aria-label="Primary navigation">
            {primaryDestinations.map((item) => (
              <a key={item.id} href={sectionHref(item.id)} onClick={(event) => onLink(event, item.id)} className={`px-top-link ${active === item.id ? "is-active" : ""}`} aria-current={active === item.id ? "page" : undefined}>{item.label}</a>
            ))}
            <button type="button" className={`px-more-trigger ${primaryDestinations.some((item) => item.id === active) ? "" : "is-active"}`} onClick={openNavigation} aria-haspopup="dialog" aria-label="More workspace pages">More<Icon name="menu" size={14} /></button>
          </nav>
          <div className="px-topbar-actions">
            <button type="button" className="px-command-trigger" onClick={openPalette} aria-label="Open command palette" aria-haspopup="dialog"><Icon name="search" size={17} /><span>Command search…</span><kbd>{shortcut}</kbd></button>
            <button type="button" className="px-wallet-action button button-secondary" onClick={onWallet} disabled={walletDisabled} title={walletDisabled ? "Wallet requires a verified testnet or mainnet RPC connection" : walletLabel}>{walletLabel}</button>
            <MotionPreferencesButton className="px-effects-action" />
            <ThemeSwitcher />
            <button type="button" className="px-icon-button px-mobile-menu" aria-label="Open navigation" aria-haspopup="dialog" onClick={openNavigation}><Icon name="menu" /></button>
          </div>
        </header>
        <main className="px-content" id="command-content" tabIndex={-1} aria-label={title}>{children}</main>
        <footer className="px-workspace-footer">
          <span className="px-footer-brand">PHOENIX <span>— Monolith Studio</span></span>
          <span className="px-footer-readonly">Read-only workspace</span>
          <span className={`px-footer-network ${rpcHealthy ? "is-connected" : ""}`}><span className="px-status-dot" />{networkLabel}<span className="px-footer-verified"> · {rpcHealthy ? "RPC verified" : "RPC unverified"}</span></span>
        </footer>
      </div>
      <dialog ref={mobileRef} className="px-mobile-dialog" aria-labelledby="px-navigation-title" onClose={() => navigationTriggerRef.current?.focus()} onClick={(event) => { if (event.target === event.currentTarget) mobileRef.current?.close(); }}>
        <div className="px-mobile-inner">
          <div className="px-mobile-heading"><div><p className="px-dialog-eyebrow">PHOENIX WORKSPACE</p><h2 id="px-navigation-title">Find your focus.</h2></div><button type="button" className="px-icon-button" onClick={() => mobileRef.current?.close()} aria-label="Close navigation"><Icon name="close" /></button></div>
          <nav className="px-nav" aria-label="All workspace pages">
            {destinations.map((item) => (
              <div className="px-nav-entry" key={item.id}>
                {item.group && <span className="px-nav-group">{item.group}</span>}
                <a href={sectionHref(item.id)} onClick={(event) => onLink(event, item.id)} className={`px-nav-link ${active === item.id ? "is-active" : ""}`} aria-current={active === item.id ? "page" : undefined}><Icon name={item.id} /><span>{item.label}</span>{active === item.id && <Icon name="check" size={14} />}</a>
              </div>
            ))}
          </nav>
          <div className="px-workspace-account">
            <div className="px-account-status"><span className={`px-network ${rpcHealthy ? "is-connected" : ""}`}><span className="px-status-dot" /><span>{networkLabel}<small>{rpcHealthy ? "RPC verified" : "RPC unverified"}</small></span></span><button type="button" className="px-icon-button px-notifications" onClick={() => navigate("security")} title="View available security events" aria-label={`View security events: ${notificationCount} available`}><Icon name="bell" />{notificationCount > 0 && <span>{notificationCount > 99 ? "99+" : notificationCount}</span>}</button></div>
            <button type="button" className="px-wallet" onClick={() => { mobileRef.current?.close(); onWallet(); }} disabled={walletDisabled} title={walletDisabled ? "Wallet requires a verified public-network RPC connection" : walletLabel}><Icon name="wallet" size={17} /><span>{walletLabel}</span></button>
            {walletDisabled && <p className="px-wallet-note">Wallet connection needs a verified public-network RPC.</p>}
            <p className="px-mobile-note"><Icon name="lock" size={14} />Read-only workspace · v5.0</p>
          </div>
        </div>
      </dialog>
      <dialog ref={paletteRef} className="px-palette" aria-labelledby="px-palette-title" onClose={() => { if (triggerRef.current?.isConnected && !triggerRef.current.closest("dialog:not([open])")) triggerRef.current.focus(); else navigationTriggerRef.current?.focus(); }} onClick={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
        <div className="px-palette-inner">
          <div className="px-palette-heading"><span id="px-palette-title">Command center</span><button type="button" className="px-icon-button" onClick={closePalette} aria-label="Close command palette"><Icon name="close" size={18} /></button></div>
          <div className="px-palette-search"><Icon name="search" /><input ref={searchRef} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} placeholder="Where would you like to go?" aria-label="Search pages" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="px-command-results" aria-activedescendant={results.length ? `px-command-${selected}` : undefined} autoComplete="off" onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setSelected((index) => results.length ? (index + 1) % results.length : 0); } else if (event.key === "ArrowUp") { event.preventDefault(); setSelected((index) => results.length ? (index - 1 + results.length) % results.length : 0); } else if (event.key === "Enter" && results[selected]) { event.preventDefault(); navigate(results[selected].id); } }} /></div>
          <div className="px-palette-results" id="px-command-results" role="listbox" aria-label="Pages">
            {results.length ? results.map((item, index) => <div role="option" id={`px-command-${index}`} key={item.id} aria-selected={selected === index} className={`px-command-result ${selected === index ? "is-selected" : ""}`} onMouseEnter={() => setSelected(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => navigate(item.id)}><Icon name={item.id} /><span>{item.label}</span><Icon name="arrow" size={15} /></div>) : <p className="px-palette-empty">No matching pages. Try “recovery” or “security”.</p>}
          </div>
          <div className="px-palette-hint"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate <kbd>↵</kbd> Open</span><span><kbd>esc</kbd> Close</span></div>
        </div>
      </dialog>
    </div>
  );
}
