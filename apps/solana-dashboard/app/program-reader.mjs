import { isSolanaAddress, readVerifiedSolanaRpc } from "./solana-rpc.mjs";

const ACCOUNT_BYTES = 373;
const TAG = "PHXN0001";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export function decodeTask(bytes) {
  if (bytes.length !== ACCOUNT_BYTES || new TextDecoder().decode(bytes.slice(0, 8)) !== TAG) {
    throw new Error("This account does not use the PHOENIX task layout.");
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const phase = ["Running", "Crashed", "Quarantined", "Closed"][data.getUint8(204)];
  if (!phase) throw new Error("Unknown PHOENIX task phase.");
  const u64 = (offset) => data.getBigUint64(offset, true).toString();
  const hex = (start) => Array.from(bytes.slice(start, start + 32), b => b.toString(16).padStart(2, "0")).join("");
  return {
    phase, generation: u64(205), heartbeatSequence: u64(213),
    heartbeatAt: data.getBigInt64(221, true).toString(),
    checkpointSequence: u64(229), checkpointHash: hex(237),
    recoveryApproval: data.getBigInt64(269, true).toString(),
    recoveryCount: u64(277), recoverySlot: u64(285), recoveryHash: hex(293),
    escrowRemaining: u64(325), escrowPaid: u64(333), escrowRefunded: u64(341),
    paymentNonce: u64(349), paymentAmount: u64(357),
    paymentApproval: data.getBigInt64(365, true).toString(),
  };
}

/** @param {"devnet" | "mainnet"} network */
export async function inspectSolanaAddress(network, program, address, signal) {
  if (!isSolanaAddress(address)) throw new Error("Enter a valid Solana public address.");
  // Read one byte past the layout so a larger account cannot match by prefix.
  const result = await readVerifiedSolanaRpc(network, "getAccountInfo", [address, {
    encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: ACCOUNT_BYTES + 1 },
  }], signal);
  const slot = result?.context?.slot;
  const value = result?.value;
  if (!Number.isSafeInteger(slot) || slot < 0 || value === undefined) {
    throw new Error("Solana RPC did not return a finalized account observation.");
  }
  if (value === null) return { slot, network, address, account: null, task: null, invalidTask: false };
  if (!isSolanaAddress(value.owner) || typeof value.executable !== "boolean") {
    throw new Error("Solana RPC returned invalid account metadata.");
  }
  const kind = value.executable ? "Executable program" : value.owner === SYSTEM_PROGRAM ? "System-owned account" : "Program-owned account";
  const lamports = Number.isSafeInteger(value.lamports) && value.lamports >= 0 ? value.lamports : null;
  const account = { kind, owner: value.owner, lamports };
  if (!isSolanaAddress(program) || value.owner !== program || value.executable) {
    return { slot, network, address, account, task: null, invalidTask: false };
  }

  try {
    if (value.data?.[1] !== "base64" || typeof value.data[0] !== "string" || value.data[0].length !== 500) {
      throw new Error("Unexpected PHOENIX task account size.");
    }
    const bytes = Uint8Array.from(atob(value.data[0]), (character) => character.charCodeAt(0));
    const task = decodeTask(bytes);
    return { slot, network, address, account, task, invalidTask: false };
  } catch {
    return { slot, network, address, account, task: null, invalidTask: true };
  }
}
