import type { ReactNode } from "react";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-700.css";
import "./style.css";
import { Header } from "./navigation";
import { WalletProvider } from "./wallet";

export const metadata = {
  title: { default: "PHOENIX | Solana Agent Recovery", template: "%s | PHOENIX" },
  description: "Recover agent tasks, control escrow and inspect on-chain evidence on Solana.",
};

export default function Layout({children}: {children: ReactNode}) {
  return <html lang="en"><body>
    <a className="skip-link" href="#content">Skip to content</a>
    <WalletProvider>
      <Header />
      <main id="content">{children}</main>
    </WalletProvider>
    <footer className="site-footer wrap">
      <b>PHOENIX</b><span>Agent recovery on Solana</span>
      <a href="https://github.com/Subash-2207/near-phoenix">Source repository</a>
    </footer>
  </body></html>;
}
