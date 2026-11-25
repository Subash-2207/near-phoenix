import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSol, mainnetAccounts, readSolanaMainnet } from "./solana-rpc.mjs";

const account = "11111111111111111111111111111111";
const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

test("wallet accounts must advertise mainnet and a valid public address", () => {
  const mainnet = { address: account, chains: ["solana:mainnet"] };
  assert.deepEqual(mainnetAccounts([
    { address: account, chains: ["solana:devnet"] },
    { address: "invalid", chains: ["solana:mainnet"] },
    mainnet,
  ]), [mainnet]);
});

test("mainnet reads use finalized data and reject wrong networks or unsafe balances", async (t) => {
  let fingerprint = genesis;
  let value = 1;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://solana-rpc.publicnode.com");
    assert.equal(options.credentials, "omit");
    const { id, method, params } = JSON.parse(options.body);
    requests.push({ method, params });
    const results = { getGenesisHash: fingerprint, getSlot: 10, getBalance: { context: { slot: 11 }, value } };
    return Response.json({ jsonrpc: "2.0", id, result: results[method] });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await readSolanaMainnet(null, signal), { slot: 10, lamports: null });
  assert.deepEqual(await readSolanaMainnet(account, signal), { slot: 11, lamports: 1 });
  assert.ok(requests.some(({method, params}) => method === "getBalance" && params[0] === account && params[1].commitment === "finalized"));
  assert.ok(requests.every(({ method }) => ["getGenesisHash", "getSlot", "getBalance"].includes(method)));
  assert.equal(formatSol(1), "0.000000001");
  assert.equal(formatSol(2_100_000_000), "2.1");
  fingerprint = "another-cluster";
  await assert.rejects(readSolanaMainnet(account, signal), /did not identify/);
  fingerprint = genesis;
  value = 2 ** 53;
  await assert.rejects(readSolanaMainnet(account, signal), /invalid slot or balance/);
});
