import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { decodeTask } from "../apps/solana-dashboard/app/program-reader.mjs";

const toolRoot = resolve("local-tools");
const require = createRequire(resolve(toolRoot, "validator-js", "package.json"));
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require("@solana/web3.js");
const elf = resolve(process.env.PHOENIX_SBF_PATH || resolve(toolRoot, "sbf", "phoenix_solana_program.so"));
if (!existsSync(elf)) throw Error("SBF binary missing.");
const key = Keypair.generate().publicKey;
const payer = Keypair.generate();
const [owner, operator, backup, sentinel, guardian] = Array.from({length:5}, () => Keypair.generate());
const taskSeed = Buffer.alloc(32, 42);
const checkpoint = Buffer.alloc(32, 57);
const [task] = PublicKey.findProgramAddressSync([Buffer.from("task"), owner.publicKey.toBuffer(), taskSeed], key);
const ledger = mkdtempSync(resolve(toolRoot, "validator-")).replace(/^D:\\/i,"/mnt/d/").replaceAll("\\","/");
const tool = resolve(toolRoot, "solana-release", "bin", "solana-test-validator").replace(/^D:\\/i, "/mnt/d/").replaceAll("\\", "/");
const binary = elf.replace(/^D:\\/i,"/mnt/d/").replaceAll("\\","/");
const validator = spawn("wsl.exe", ["-d","Ubuntu","--",tool,"--ledger",ledger,"--rpc-port","8897","--bpf-program",key.toBase58(),binary,"--mint",payer.publicKey.toBase58()], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let tail = "";
for (const stream of [validator.stdout, validator.stderr]) stream.on("data", bytes => {tail = (tail + bytes).slice(-3500);});
const rpc = new Connection("http://127.0.0.1:8897", "confirmed");

function fixed(n, width) {
  const out = Buffer.alloc(width);
  if (width === 8) out.writeBigUInt64LE(BigInt(n));
  else out.writeUInt32LE(n);
  return out;
}
async function transaction(actor, discriminator, parts = [], writable = false, cosigner) {
  const accounts = [
    { pubkey: actor.publicKey, isSigner: true, isWritable: writable },
    { pubkey: task, isSigner: false, isWritable: true },
  ];
  if (discriminator === 0) accounts.push({pubkey:SystemProgram.programId,isSigner:false,isWritable:false});
  if (cosigner) accounts.push({pubkey:cosigner.publicKey,isSigner:true,isWritable:false});
  const tx = new Transaction().add(new TransactionInstruction({
    programId:key, keys:accounts, data:Buffer.concat([Buffer.from([discriminator]),...parts]),
  }));
  tx.feePayer = payer.publicKey;
  return sendAndConfirmTransaction(rpc,tx,cosigner ? [payer,actor,cosigner] : [payer,actor],{commitment:"confirmed"});
}
const u = v => fixed(v, 8);
async function clock() {
  const ts = await rpc.getBlockTime(await rpc.getSlot("confirmed"));
  return ts ?? Math.floor(Date.now()/1000);
}
async function expectFailure(action, code) {
  await assert.rejects(action, (e) => new RegExp("custom program error: 0x"+ code.toString(16),"i").test(String(e)));
}
async function state(level = "confirmed") {
  const a = await rpc.getAccountInfo(task, level);
  assert.ok(a && a.owner.equals(key));
  return {task:decodeTask(a.data),lamports:a.lamports};
}
try {
  let ready = false;
  for(let tries=0; tries<40; tries++) {
    if (validator.exitCode != null) throw Error("Validator exited: "+tail.slice(-1600));
    try { await rpc.getVersion(); ready = true; break; } catch {await wait(550);}
  }
  if (!ready) throw Error("Validator did not start: "+tail.slice(-1600));
  await sendAndConfirmTransaction(
    rpc, new Transaction().add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:owner.publicKey,lamports:4_000_000_000})), [payer],
  );
  // A pre-funded PDA must still initialize, without mistaking the deposit for task principal.
  await sendAndConfirmTransaction(
    rpc, new Transaction().add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:task,lamports:2_000_000})), [payer],
  );
  const escrow = 2_000_000_000;
  const window = 14;
  const created = await transaction(owner,0,[taskSeed,...[operator,backup,sentinel,guardian].map(a=>a.publicKey.toBuffer()),fixed(window,4),u(escrow)],true);
  assert.equal((await state()).task.escrowRemaining,String(escrow));
  const since = Number((await state()).task.heartbeatAt);
  await transaction(operator,2,[u(1),u(1),checkpoint]);
  await expectFailure(() => transaction(guardian,3),7);
  const deadline = Date.now() + 30_000;
  while ((await clock()) < since + window + 1) {
    if (Date.now() > deadline) throw Error("Validator clock did not reach heartbeat expiry.");
    await wait(500);
  }
  await transaction(guardian,3);
  await transaction(guardian,4);
  await expectFailure(() => transaction(guardian,5),1);
  await transaction(owner,5);
  await expectFailure(() => transaction(backup,7,[u(1),checkpoint]),6);
  const expiry = u(await clock() + 120);
  await transaction(sentinel,6,[u(1),checkpoint,expiry]);
  const recovered = await transaction(backup,7,[u(1),checkpoint]);
  assert.equal((await state()).task.generation,"2");
  await expectFailure(() => transaction(operator,1,[u(1),u(1)]),1);
  const payout = 500_000_000;
  const initialBackup = await rpc.getBalance(backup.publicKey);
  const authorizePayout = [u(2),u(1),u(payout),expiry,checkpoint];
  await expectFailure(() => transaction(sentinel,8,authorizePayout),1);
  await expectFailure(() => transaction(sentinel,8,authorizePayout,false,guardian),1);
  await expectFailure(() => transaction(sentinel,8,[...authorizePayout.slice(0,4),Buffer.alloc(32,63)],false,owner),6);
  await transaction(sentinel,8,authorizePayout,false,owner);
  await transaction(backup,2,[u(2),u(2),Buffer.alloc(32,63)]);
  await expectFailure(() => transaction(backup,9,[u(2),u(1),u(payout)],true),6);
  await transaction(backup,2,[u(2),u(3),checkpoint]);
  await transaction(sentinel,8,authorizePayout,false,owner);
  await expectFailure(() => transaction(backup,9,[u(2),u(1),u(payout-1)],true),6);
  const paid = await transaction(backup,9,[u(2),u(1),u(payout)],true);
  await expectFailure(() => transaction(backup,9,[u(2),u(1),u(payout)],true),5);
  assert.equal(await rpc.getBalance(backup.publicKey),initialBackup + payout);
  await transaction(guardian,4);
  const refunded = await transaction(owner,10,[],true);
  const result = await state();
  assert.equal(result.task.phase,"Closed");
  assert.equal(result.task.escrowRemaining,"0");
  assert.equal(result.task.escrowPaid,String(payout));
  assert.equal(result.task.escrowRefunded,String(escrow-payout));
  assert.equal(result.task.recoveryHash,checkpoint.toString("hex"));
  assert.ok(result.lamports >= await rpc.getMinimumBalanceForRentExemption(373));
  console.log("Local validator verified PDA creation, quarantine, approved recovery, stale-worker rejection, customer co-signing, settlement, replay rejection and refund.");
  console.log(JSON.stringify({ program:key.toBase58(),task:task.toBase58(), created,recovered,paid,refunded, state:result.task },null,2));
} catch(error) {
  console.error(String(error));
  console.error(tail.slice(-1500));
  process.exitCode = 1;
} finally {
  const stop = spawn("wsl.exe", ["-d","Ubuntu","--","pkill","-f","^"+tool+" --ledger "+ledger+" --rpc-port 8897"], {stdio:"ignore",windowsHide:true});
  await new Promise(resolve => stop.on("close", resolve));
  validator.kill();
  validator.stdout.destroy();
  validator.stderr.destroy();
  await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write("", resolve))));
  process.exit(process.exitCode ?? 0);
}
