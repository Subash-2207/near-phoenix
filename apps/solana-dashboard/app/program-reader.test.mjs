import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTask, inspectSolanaAddress } from "./program-reader.mjs";

const program = "So11111111111111111111111111111111111111112";
const address = "11111111111111111111111111111111";
const fingerprint = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

function fixture() {
  const raw = Buffer.alloc(373);
  raw.write("PHXN0001");
  raw[204] = 2;
  raw.writeBigUInt64LE(2n, 205);
  raw.writeBigUInt64LE(1n, 277);
  raw.writeBigUInt64LE(125n, 285);
  raw.fill(9, 293, 325);
  raw.writeBigUInt64LE(1_500_000_000n, 325);
  raw.writeBigUInt64LE(500_000_000n, 333);
  raw.writeBigUInt64LE(1n, 349);
  return raw;
}

test("decodes the fixed Rust task layout and rejects unknown layouts", () => {
  const raw = fixture();
  const task = decodeTask(raw);
  assert.equal(task.phase, "Quarantined");
  assert.equal(task.generation, "2");
  assert.equal(task.recoveryCount, "1");
  assert.equal(task.recoverySlot, "125");
  assert.equal(task.recoveryHash, "09".repeat(32));
  assert.equal(task.escrowRemaining, "1500000000");
  assert.equal(task.escrowPaid, "500000000");
  assert.throws(() => decodeTask(raw.slice(1)), /layout/);
  raw[204] = 255;
  assert.throws(() => decodeTask(raw), /Unknown/);
});

test("requires finalized bytes owned by the configured program and a matching cluster", async t => {
  let owner = program;
  let chain = fingerprint;
  let bytes = fixture();
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const {method, params, id} = JSON.parse(options.body);
    if (method === "getAccountInfo") assert.deepEqual(params, [address, {
      encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 374 },
    }]);
    return Response.json({id,result:method === "getGenesisHash" ? chain : {
      value: {owner, executable:false, lamports:1, data: [bytes.toString("base64"), "base64"]},
      context: {slot: 321},
    }});
  });
  const signal = new AbortController().signal;
  assert.equal((await inspectSolanaAddress("devnet", program, address, signal)).task.generation, "2");
  bytes = Buffer.concat([fixture(), Buffer.alloc(1)]);
  const largerAccount = await inspectSolanaAddress("devnet", program, address, signal);
  assert.equal(largerAccount.task, null);
  assert.equal(largerAccount.invalidTask, true);
  bytes = fixture();
  owner = address;
  assert.equal((await inspectSolanaAddress("devnet", program, address, signal)).task, null);
  chain = "wrong";
  await assert.rejects(inspectSolanaAddress("devnet", program, address, signal), /network/);
});

test("looks up mainnet addresses without configured PHOENIX deployment", async t => {
  let value = { owner: address, executable: false, lamports: 12, data: ["", "base64"] };
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://solana-rpc.publicnode.com");
    const { method, id } = JSON.parse(options.body);
    return Response.json({ id, result: method === "getGenesisHash"
      ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" : { value, context: { slot: 321 } } });
  });
  const signal = new AbortController().signal;
  const systemAccount = await inspectSolanaAddress("mainnet", "", program, signal);
  assert.deepEqual(systemAccount.account, { kind: "System-owned account", owner: address, lamports: 12 });
  assert.equal(systemAccount.slot, 321);
  assert.equal(systemAccount.task, null);
  value = null;
  const absent = await inspectSolanaAddress("mainnet", "", program, signal);
  assert.equal(absent.account, null);
  assert.equal(absent.slot, 321);
  const requests = fetch.mock.callCount();
  await assert.rejects(inspectSolanaAddress("mainnet", "", "z".repeat(44), signal), /valid Solana public address/);
  assert.equal(fetch.mock.callCount(), requests);
});
