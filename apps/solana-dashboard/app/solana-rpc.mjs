export const SOLANA_MAINNET_CHAIN = "solana:mainnet";
const NETWORKS = {
  devnet: { rpc: "https://api.devnet.solana.com", genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
  mainnet: { rpc: "https://solana-rpc.publicnode.com", genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" },
};
const PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function isSolanaAddress(address) {
  if (typeof address !== "string" || !PUBLIC_KEY.test(address)) return false;
  let value = 0n;
  for (const digit of address) value = value * 58n + BigInt(BASE58.indexOf(digit));
  const leadingZeroes = address.match(/^1*/)[0].length;
  const valueBytes = value === 0n ? 0 : Math.ceil(value.toString(16).length / 2);
  return leadingZeroes + valueBytes === 32;
}

export function mainnetAccounts(accounts) {
  return accounts.filter((account) =>
    account.chains.includes(SOLANA_MAINNET_CHAIN) && isSolanaAddress(account.address)
  );
}

export function formatSol(lamports) {
  const amount = BigInt(lamports);
  const whole = amount / 1_000_000_000n;
  const remainder = (amount % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return remainder ? whole.toLocaleString() + "." + remainder : whole.toLocaleString();
}

async function rpc(endpoint, method, params, signal) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal,
  });
  if (response.status === 429) throw new Error("Solana RPC is rate limited. Try again shortly.");
  if (!response.ok) throw new Error("Solana RPC returned HTTP " + response.status + ".");
  const data = await response.json();
  if (!data || data.id !== method || data.error || !("result" in data)) {
    throw new Error("Solana RPC returned an invalid " + method + " response.");
  }
  return data.result;
}

/** @param {"devnet" | "mainnet"} network */
export async function readVerifiedSolanaRpc(network, method, params, signal) {
  const cluster = NETWORKS[network];
  if (!cluster) throw new Error("Select a supported Solana network.");
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const [genesis, reading] = await Promise.all([
    rpc(cluster.rpc, "getGenesisHash", [], requestSignal),
    rpc(cluster.rpc, method, params, requestSignal),
  ]);
  if (genesis !== cluster.genesis) throw new Error("Solana RPC did not identify itself as the selected network.");
  return reading;
}

export async function readSolanaMainnet(address, signal) {
  if (address !== null && !isSolanaAddress(address)) throw new Error("Invalid Solana address.");
  const commitment = { commitment: "finalized" };
  const reading = address === null
    ? await readVerifiedSolanaRpc("mainnet", "getSlot", [commitment], signal)
    : await readVerifiedSolanaRpc("mainnet", "getBalance", [address, commitment], signal);
  const slot = address === null ? reading : reading?.context?.slot;
  const lamports = address === null ? null : reading?.value;
  if (!Number.isSafeInteger(slot) || slot < 0 ||
      (lamports !== null && (!Number.isSafeInteger(lamports) || lamports < 0)) ||
      (address !== null && lamports === null)) {
    throw new Error("Solana RPC returned an invalid slot or balance.");
  }
  return { slot, lamports };
}
