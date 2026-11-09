const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SUPPORTED_WALLET_NETWORKS = new Set(["mainnet", "testnet"]);

export function walletNetworkMatches(health, walletNetworkId) {
  return health?.connected === true
    && SUPPORTED_WALLET_NETWORKS.has(health.network)
    && health.chainId === health.network
    && walletNetworkId === health.network;
}

export function walletSessionTransition(current, event) {
  switch (event.type) {
    case "connecting":
      return { status: "connecting", accountId: null, network: null, error: null };
    case "connected":
      if (!walletNetworkMatches(event.health, event.walletNetworkId)) {
        return { status: "error", accountId: null, network: null, error: "Wallet and verified NEAR RPC networks do not match." };
      }
      if (typeof event.accountId !== "string" || !ACCOUNT_ID.test(event.accountId)) {
        return { status: "error", accountId: null, network: null, error: "Wallet returned an invalid account ID." };
      }
      return { status: "connected", accountId: event.accountId, network: event.health.network, error: null };
    case "rejected":
    case "cancelled":
      return { status: "error", accountId: null, network: null, error: "Wallet connection was rejected or closed. No transaction was signed." };
    case "disconnected":
      return { status: "disconnected", accountId: null, network: null, error: null };
    case "network-mismatch":
      return { status: "error", accountId: null, network: null, error: "Wallet changed networks. Reconnect only after the RPC reports the same network." };
    default:
      return current;
  }
}
