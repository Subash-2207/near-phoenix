import { createHash } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Durable, fail-closed replay claims for verified recovery receipts.
 * A successful claim is an exclusive file creation followed by file and
 * directory fsync, so concurrent backend processes cannot both accept it.
 */
export class ReceiptReplayLedger {
  readonly directory: string;

  constructor(directory = defaultReceiptLedgerDirectory()) {
    this.directory = resolve(directory);
  }

  async claim(signature: string): Promise<boolean> {
    if (!/^[0-9a-f]{128}$/.test(signature)) return false;
    await this.#ensurePrivateDirectory();

    const digest = createHash("sha256").update(signature, "hex").digest("hex");
    const marker = join(this.directory, `${digest}.json`);
    let file;
    try {
      file = await open(marker, "wx", 0o600);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return false;
      throw error;
    }

    try {
      await file.writeFile(JSON.stringify({ version: 1, signature_digest: digest }) + "\n", { encoding: "utf8" });
      await file.sync();
      await file.close();
      const directory = await open(this.directory, "r");
      try { await directory.sync(); }
      finally { await directory.close(); }
      return true;
    } catch (error) {
      // Keep any marker that was created. A partial marker must block replay
      // rather than make the same receipt claimable after a restart.
      try { await file.close(); } catch { /* Already closed. */ }
      throw error;
    }
  }

  async #ensurePrivateDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Receipt replay ledger path must be a real directory");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Receipt replay ledger directory must be owned by the backend user");
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("Receipt replay ledger directory permissions must be private (0700)");
    }
  }
}

export function defaultReceiptLedgerDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PHOENIX_RECEIPT_REPLAY_DIR;
  if (configured) return isAbsolute(configured) ? configured : resolve(configured);
  const stateRoot = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : join(homedir(), ".local", "state");
  return join(stateRoot, "near-phoenix", "receipt-replay");
}
