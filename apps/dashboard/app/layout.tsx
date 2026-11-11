import type { ReactNode } from "react";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-700.css";
import "./globals.css";
import "./theme-overrides.css";
import "./monolith-theme.css";
import "./atmosphere.css";
import "./midnight.css";
import { ThemeProvider } from "./components/theme-provider";
import { MotionPreferencesProvider } from "./components/motion-preferences";
export const metadata = {
  title: "PHOENIX | Monolith Studio",
  description:
    "NEAR PHOENIX v5.0 — agent recovery, signed security evidence and read-only escrow intelligence",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ThemeProvider>
          <MotionPreferencesProvider>
            {children}
          </MotionPreferencesProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
