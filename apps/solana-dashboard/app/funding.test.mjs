import assert from 'node:assert/strict';
import test from 'node:test';
import { fundingInstruction } from './funding.mjs';

test('the wallet instruction binds the exact project seed, authorities and SOL principal', () => {
  const chain={program:'So11111111111111111111111111111111111111112',
    operator:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',backup:'ComputeBudget111111111111111111111111111111',
    sentinel:'AddressLookupTab1e1111111111111111111111111',guardian:'Vote111111111111111111111111111111111111111'};
  const owner='11111111111111111111111111111111';
  const seed='2a'.repeat(32);
  const {instruction,task,payer}=fundingInstruction(chain,owner,seed,'1250000000');
  assert.equal(payer.toBase58(),owner);
  assert.equal(instruction.programId.toBase58(),chain.program);
  assert.ok(instruction.keys[0].isSigner);
  assert.ok(instruction.keys[1].pubkey.equals(task));
  assert.equal(instruction.data.length,173);
  assert.equal(instruction.data[0],0);
  assert.equal(instruction.data.subarray(1,33).toString('hex'),seed);
  assert.equal(instruction.data.readUInt32LE(161),86400);
  assert.equal(instruction.data.readBigUInt64LE(165),1250000000n);
  assert.throws(()=>fundingInstruction(chain,chain.sentinel,seed,'1'),/distinct/);
  assert.throws(()=>fundingInstruction(chain,owner,seed,'18446744073709551616'),/funding amount/);
});
