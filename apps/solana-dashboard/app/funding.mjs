import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { readVerifiedSolanaRpc } from './solana-rpc.mjs';

export function fundingInstruction(chain, owner, seed, budget) {
  if (!/^[a-f0-9]{64}$/.test(seed) || !/^[0-9]+$/.test(budget)) throw new Error('Invalid project funding parameters.');
  const lamports = BigInt(budget);
  if (lamports <= 0n || lamports > 18446744073709551615n) throw new Error('Invalid project funding amount.');
  const payer = new PublicKey(owner);
  const programId = new PublicKey(chain.program);
  const authorities = [chain.operator, chain.backup, chain.sentinel, chain.guardian].map(value => new PublicKey(value));
  if (new Set([payer, ...authorities].map(key => key.toBase58())).size !== 5) throw new Error('The funding wallet and each program authority must be distinct.');
  const id = Buffer.from(seed, 'hex');
  const [task] = PublicKey.findProgramAddressSync([Buffer.from('task'), payer.toBuffer(), id], programId);
  const data = Buffer.alloc(173);
  id.copy(data, 1);
  authorities.forEach((key, i) => key.toBuffer().copy(data, 33 + i * 32));
  data.writeUInt32LE(86400, 161);
  data.writeBigUInt64LE(lamports, 165);
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: task, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return { task, payer, instruction: new TransactionInstruction({ programId, keys, data }) };
}

export async function fundingTransaction(chain, owner, seed, budget, signal) {
  const { task, payer, instruction } = fundingInstruction(chain, owner, seed, budget);
  const response = await readVerifiedSolanaRpc('mainnet', 'getLatestBlockhash', [{ commitment: 'finalized' }], signal);
  const lifetime = response?.value;
  if (typeof lifetime?.blockhash !== 'string' || !Number.isSafeInteger(lifetime?.lastValidBlockHeight)) {
    throw new Error('Solana did not return a usable transaction lifetime.');
  }
  const transaction = new Transaction({ feePayer: payer, blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight }).add(instruction);
  return { task: task.toBase58(), transaction: new Uint8Array(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })) };
}
