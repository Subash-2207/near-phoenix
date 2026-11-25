"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getWallets } from "@wallet-standard/app";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";
import { formatSol, mainnetAccounts, readSolanaMainnet, SOLANA_MAINNET_CHAIN } from "./solana-rpc.mjs";
type Wallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
type Account = Wallet["accounts"][number];
type SolanaWallet = Wallet & {
  features: StandardConnectFeature & Partial<StandardDisconnectFeature & StandardEventsFeature>;
};
type Session = { wallet: SolanaWallet; accounts: readonly Account[]; address: string };
type Reading = { address: string | null; slot: number; lamports: number | null };
type WalletContext = {
  session: Session | null;
  switching: boolean;
  walletError: string;
  openPicker: (trigger: HTMLButtonElement) => void;
  disconnect: () => Promise<void>;
  selectAccount: (address: string) => void;
};

const WalletState = createContext<WalletContext | null>(null);
const preferredWalletKey = "phoenix-connected-wallet";
const downloads = [
  { name: "Phantom", href: "https://phantom.com/download" },
  { name: "Solflare", href: "https://www.solflare.com/download/" },
  { name: "Backpack", href: "https://backpack.app/download" },
];

function isSolanaWallet(wallet: Wallet): wallet is SolanaWallet {
  const features = wallet.features as Partial<StandardConnectFeature>;
  return wallet.chains.includes(SOLANA_MAINNET_CHAIN) &&
    typeof features["standard:connect"]?.connect === "function";
}

function shortAddress(address: string) {
  return address.slice(0, 8) + "…" + address.slice(-6);
}

export function useWallet() {
  const value = useContext(WalletState);
  if (!value) throw new Error("WalletProvider is required");
  return value;
}

export function ConnectWalletButton({ className }: { className: string }) {
  const { session, openPicker } = useWallet();
  return <button type="button" className={className} aria-haspopup="dialog"
    aria-label={session ? "Manage connected wallet" : undefined} onClick={(event) => openPicker(event.currentTarget)}>
    {session ? shortAddress(session.address) : "Connect wallet"}
  </button>;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<readonly SolanaWallet[]>([]);
  const [discovered, setDiscovered] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [connecting, setConnecting] = useState<SolanaWallet | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [walletError, setWalletError] = useState("");
  const picker = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const preferredWallet = useRef<string | null>(null);
  const wallet = session?.wallet;

  useEffect(() => {
    const registry = getWallets();
    try { preferredWallet.current = window.sessionStorage.getItem(preferredWalletKey); } catch { /* Storage can be unavailable. */ }
    const sync = () => {
      const available = registry.get().filter(isSolanaWallet);
      setWallets(available);
      setDiscovered(true);
      const previous = available.find((item) => item.name === preferredWallet.current);
      const accounts: readonly Account[] = mainnetAccounts(previous?.accounts ?? []);
      setSession((current) => {
        if (current) return available.includes(current.wallet) ? current : null;
        return previous && accounts.length > 0 ? { wallet: previous, accounts, address: accounts[0].address } : null;
      });
    };
    const offRegister = registry.on("register", sync);
    const offUnregister = registry.on("unregister", sync);
    sync();
    return () => { offRegister(); offUnregister(); };
  }, []);

  useEffect(() => {
    if (!wallet) return;
    return wallet.features["standard:events"]?.on("change", (change) => {
      if (!change.accounts && !change.chains) return;
      const accounts: readonly Account[] = mainnetAccounts(change.accounts ?? wallet.accounts);
      setSession((current) => {
        if (current?.wallet !== wallet) return current;
        if (!accounts.length || !isSolanaWallet(wallet)) return null;
        const selected = accounts.find((account) => account.address === current.address) ?? accounts[0];
        return { wallet, accounts, address: selected.address };
      });
    });
  }, [wallet]);

  async function connect(selected: SolanaWallet) {
    setConnecting(selected);
    setWalletError("");
    try {
      const result = await selected.features["standard:connect"].connect();
      const accounts: readonly Account[] = mainnetAccounts(result.accounts);
      if (accounts.length === 0) throw new Error("Choose an account that supports Solana mainnet.");
      if (!getWallets().get().includes(selected)) throw new Error("This wallet is no longer available in your browser.");
      preferredWallet.current = selected.name;
      try { window.sessionStorage.setItem(preferredWalletKey, selected.name); } catch { /* The wallet session still works in this page. */ }
      setSession({ wallet: selected, accounts, address: accounts[0].address });
      picker.current?.close();
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Wallet connection cancelled or unavailable.");
    } finally {
      setConnecting(null);
    }
  }

  async function disconnect() {
    if (!wallet) return;
    setDisconnecting(true);
    setWalletError("");
    preferredWallet.current = null;
    try { window.sessionStorage.removeItem(preferredWalletKey); } catch { /* Storage can be unavailable. */ }
    try {
      await wallet.features["standard:disconnect"]?.disconnect();
    } catch {
      setWalletError("This dashboard cleared the account. Manage extension permissions from your wallet.");
    } finally {
      setSession(null);
      setDisconnecting(false);
    }
  }

  const switching = connecting !== null || disconnecting;
  const installedNames = new Set(wallets.map((item) => item.name.toLowerCase()));
  const availableDownloads = downloads.filter(({ name }) => !installedNames.has(name.toLowerCase()));
  const openPicker = (button: HTMLButtonElement) => {
    trigger.current = button;
    setWalletError("");
    picker.current?.showModal();
  };

  return <WalletState.Provider value={{ session, switching, walletError, openPicker, disconnect,
    selectAccount: (address) => setSession((current) => current?.accounts.some((account) => account.address === address) ? { ...current, address } : current),
  }}>
    {children}
    <dialog className="wallet-picker" ref={picker} aria-labelledby="wallet-picker-title" aria-describedby="wallet-picker-help"
      onClose={() => trigger.current?.focus()} onClick={(event) => { if (event.target === event.currentTarget) picker.current?.close(); }}>
      <div className="wallet-picker-content">
        <div className="wallet-picker-heading">
          <h2 id="wallet-picker-title">Connect a Solana wallet</h2>
          <button type="button" className="menu-trigger" onClick={() => picker.current?.close()}>Close</button>
        </div>
        <p id="wallet-picker-help">Choose a wallet that supports Solana mainnet.</p>
        {session && <div className="wallet-picker-session">
          <span>{session.wallet.name} · {shortAddress(session.address)}</span>
          <Link className="text-link" href="/wallet" onClick={() => picker.current?.close()}>Manage wallet</Link>
        </div>}
        <h3>Detected wallets</h3>
        {wallets.length > 0 ? <ul className="wallet-picker-options">
          {wallets.map((item, index) => <li key={item.name + index}>
            <button type="button" disabled={switching || item === wallet} onClick={() => void connect(item)}>
              {/^(data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,)/i.test(item.icon) && <img src={item.icon} alt="" width={28} height={28} />}
              <span>{item.name}</span>
              <small>{item === wallet ? "Connected" : item === connecting ? "Connecting…" : "Connect"}</small>
            </button>
          </li>)}
        </ul> : <p role="status">{discovered ? "No compatible wallet detected in this browser. Open a browser with your wallet installed, or choose an install link below." : "Checking for wallets…"}</p>}
        {walletError && <p className="notice warning" role="alert">{walletError}</p>}
        {availableDownloads.length > 0 && <>
          <h3>Install a wallet</h3>
          <ul className="wallet-picker-options">
            {availableDownloads.map(({ name, href }) => <li key={name}>
              <a href={href} target="_blank" rel="noreferrer"><span>{name}</span><small>Get wallet</small></a>
            </li>)}
          </ul>
        </>}
      </div>
    </dialog>
  </WalletState.Provider>;
}

export function WalletWorkspace() {
  const { session, switching, walletError, disconnect, selectAccount } = useWallet();
  const [reading, setReading] = useState<Reading | null>(null);
  const [rpcError, setRpcError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const address = session?.address ?? null;

  useEffect(() => {
    const controller = new AbortController();
    setReading(null);
    setRpcError("");
    void readSolanaMainnet(address, controller.signal).then((result) => {
      if (!controller.signal.aborted) setReading({ address, ...result });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setRpcError(error instanceof Error && error.name !== "TimeoutError"
          ? error.message : "The Solana RPC did not respond in time.");
      }
    });
    return () => controller.abort();
  }, [address, refreshCount]);

  const result = reading?.address === address ? reading : null;
  return (
    <div className="two-grid solana-mainnet">
      <section className="card" aria-labelledby="solana-wallet-title">
        <h2 id="solana-wallet-title">Solana wallet</h2>
        <p>Connect a Wallet Standard wallet such as Phantom or Solflare to view your mainnet account.</p>
        {session ? (
          <>
            <div className="field">
              <span>Wallet</span>
              <strong>{session.wallet.name}</strong>
            </div>
            {session.accounts.length > 1 && (
              <label className="solana-account-picker">
                Account
                <select value={session.address} disabled={switching} onChange={(event) => selectAccount(event.target.value)}>
                  {session.accounts.map((account) => (
                    <option key={account.address} value={account.address}>
                      {account.label || shortAddress(account.address)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="field">
              <span>Public address</span>
              <strong className="solana-address">
                {session.address}
              </strong>
            </div>
            <div className="solana-actions">
              <a className="text-button" href={"https://explorer.solana.com/address/" + session.address} target="_blank" rel="noreferrer">Open in Solana Explorer</a>
              <button type="button" className="button button-secondary" disabled={switching} onClick={() => void disconnect()}>Disconnect</button>
            </div>
          </>
        ) : (
          <div className="solana-actions">
            <ConnectWalletButton className="button primary" />
          </div>
        )}
        {walletError && <p className="notice warning" role="alert">{walletError}</p>}
      </section>
      <section className="card" aria-labelledby="solana-rpc-title">
        <h2 id="solana-rpc-title">Mainnet activity</h2>
        <div className="field"><span>Network</span><strong>Solana mainnet</strong></div>
        <div className="field"><span>Finalized slot</span><strong>{result ? result.slot.toLocaleString() : "—"}</strong></div>
        <div className="field">
          <span>Native SOL balance</span>
          <strong>{result?.lamports != null ? formatSol(result.lamports) + " SOL" : "—"}</strong>
        </div>
        <p role="status">{rpcError || (result ? "Mainnet RPC verified. Slot and balance use finalized data." : "Checking the Solana mainnet RPC…")}</p>
        <button type="button" className="button button-secondary" disabled={!result && !rpcError}
          onClick={() => setRefreshCount((count) => count + 1)}>Refresh Solana data</button>
        <p>Wallet connection shares your public address with this page. The balance lookup sends it to PublicNode, the Solana RPC provider.</p>
      </section>
    </div>
  );
}
