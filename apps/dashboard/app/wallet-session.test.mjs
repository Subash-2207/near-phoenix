import { test } from "node:test";
import assert from "node:assert/strict";
import { walletNetworkMatches, walletSessionTransition } from "./wallet-session.mjs";

const mainnet = { network: "mainnet", chainId: "mainnet", connected: true };
const disconnected = { network: "mainnet", chainId: "mainnet", connected: false };

test("a wallet account is accepted only when verified RPC and selector agree", () => {
  assert.equal(walletNetworkMatches(mainnet, "mainnet"), true);
  assert.deepEqual(walletSessionTransition({}, { type: "connected", health: mainnet, walletNetworkId: "mainnet", accountId: "alice.near" }), {
    status: "connected", accountId: "alice.near", network: "mainnet", error: null,
  });
});

test("wallet network mismatch, localnet and RPC outage clear account state", () => {
  for (const [health, walletNetworkId] of [
    [{ network: "mainnet", chainId: "testnet", connected: true }, "mainnet"],
    [mainnet, "testnet"],
    [{ network: "localnet", chainId: "localnet", connected: true }, "localnet"],
    [disconnected, "mainnet"],
  ]) {
    assert.equal(walletNetworkMatches(health, walletNetworkId), false);
    assert.equal(walletSessionTransition({ accountId: "alice.near" }, { type: "connected", health, walletNetworkId, accountId: "alice.near" }).accountId, null);
  }
});

test("rejected connection and disconnect do not preserve stale accounts", () => {
  const connected = { status: "connected", accountId: "alice.near", network: "mainnet" };
  const rejected = walletSessionTransition(connected, { type: "rejected" });
  assert.equal(rejected.accountId, null);
  assert.match(rejected.error, /rejected or closed/);
  assert.match(rejected.error, /No transaction was signed/);
  assert.equal(walletSessionTransition(connected, { type: "cancelled" }).accountId, null);
  assert.equal(walletSessionTransition(connected, { type: "cancelled" }).status, "error");
  assert.equal(walletSessionTransition(connected, { type: "disconnected" }).status, "disconnected");
  assert.equal(walletSessionTransition(connected, { type: "disconnected" }).accountId, null);
});

test("malformed wallet accounts and wallet network changes fail closed", () => {
  const malformed = walletSessionTransition({}, { type: "connected", health: mainnet, walletNetworkId: "mainnet", accountId: "alice.near?redirect=evil" });
  assert.equal(malformed.status, "error");
  assert.equal(malformed.accountId, null);
  const switched = walletSessionTransition({ status: "connected", accountId: "alice.near", network: "mainnet" }, { type: "network-mismatch" });
  assert.equal(switched.status, "error");
  assert.equal(switched.accountId, null);
});
