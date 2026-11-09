export function networkFromEnvironment(value: string | undefined): "localnet" | "testnet" {
 const network = value ?? "localnet";
 if (network !== "localnet" && network !== "testnet") throw new Error("Only localnet and testnet supported");
 return network;
}
export function authorizeSpend(amount: string, remaining: string): boolean {
 if (!/^[1-9][0-9]{0,38}$/.test(amount) || !/^(0|[1-9][0-9]{0,38})$/.test(remaining)) return false;
 const max = (1n << 128n) - 1n;
 return BigInt(amount) <= max && BigInt(remaining) <= max && BigInt(amount) <= BigInt(remaining);
}
