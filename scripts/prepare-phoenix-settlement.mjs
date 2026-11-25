import { readFileSync } from 'node:fs';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { readVerifiedSolanaRpc } from '../apps/solana-dashboard/app/solana-rpc.mjs';
import { chainConfig, isFunded, readProjectTask } from '../apps/production/server/solana.mjs';

const path = process.argv[2];
if (!path) throw new Error('Give the approval manifest downloaded from the PHOENIX workspace.');
const project = JSON.parse(readFileSync(path,'utf8'));
const config = chainConfig(process.env);
if (!config || project.state !== 'approved' || !/^[a-f0-9]{64}$/.test(project.delivery_hash)) {
  throw new Error('Configure the public mainnet authority addresses and use an approved delivery manifest.');
}
const { state, slot, authorities } = await readProjectTask(config,project,project.task,project.wallet);
if (!isFunded(state,project.budget)) throw new Error('The account no longer has the approved principal available for settlement.');
const signal = new AbortController().signal;
const [clock,blockhash] = await Promise.all([
  readVerifiedSolanaRpc('mainnet','getBlockTime',[slot],signal),
  readVerifiedSolanaRpc('mainnet','getLatestBlockhash',[{ commitment:'finalized' }],signal),
]);
if (!Number.isSafeInteger(clock) || !blockhash?.value?.blockhash) throw new Error('Solana did not return the required transaction timing.');

const owner = new PublicKey(authorities.owner);
const operator = new PublicKey(authorities.operator);
const sentinel = new PublicKey(authorities.sentinel);
const task = new PublicKey(project.task);
const programId = new PublicKey(config.program);
const digest = Buffer.from(project.delivery_hash,'hex');
const generation = BigInt(state.generation);
const nonce = BigInt(state.paymentNonce) + 1n;
const encode = (value) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; };
function action(discriminator, actor, payloads, coSign = false, writable = false) {
  const keys = [{pubkey:actor,isSigner:true,isWritable:writable},{pubkey:task,isSigner:false,isWritable:true}];
  if (coSign) keys.push({pubkey:owner,isSigner:true,isWritable:false});
  return new TransactionInstruction({programId,keys,data:Buffer.concat([Buffer.from([discriminator]),...payloads])});
}
const transaction=new Transaction({feePayer:operator,...blockhash.value}).add(
  action(1,operator,[encode(generation),encode(BigInt(state.heartbeatSequence)+1n)]),
  action(2,operator,[encode(generation),encode(BigInt(state.checkpointSequence)+1n),digest]),
  action(8,sentinel,[encode(generation),encode(nonce),encode(project.budget),encode(clock+120),digest],true),
  action(9,operator,[encode(generation),encode(nonce),encode(project.budget)],false,true),
);
console.log(JSON.stringify({network:'mainnet',task:project.task, program:config.program, lamports:project.budget,
  deliveryDigest:project.delivery_hash, signers:[authorities.operator,authorities.sentinel,authorities.owner],
  lastValidBlockHeight:blockhash.value.lastValidBlockHeight,
  unsignedTransaction:transaction.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),
},null,2));
