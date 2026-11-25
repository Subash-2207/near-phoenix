import { decodeTask } from '../../solana-dashboard/app/program-reader.mjs';
import { isSolanaAddress, readVerifiedSolanaRpc } from '../../solana-dashboard/app/solana-rpc.mjs';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeAddress(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let output = '';
  while (value) {
    output = alphabet[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte) break;
    output = '1' + output;
  }
  return output;
}

export function chainConfig(env) {
  const roles = [env.PHOENIX_OPERATOR, env.PHOENIX_BACKUP, env.PHOENIX_SENTINEL, env.PHOENIX_GUARDIAN];
  if (!isSolanaAddress(env.PHOENIX_PROGRAM_ID) || !roles.every(isSolanaAddress) || new Set(roles).size !== roles.length ||
      [...roles, env.PHOENIX_PROGRAM_ID].includes('11111111111111111111111111111111')) return null;
  const [operator, backup, sentinel, guardian] = roles;
  return { program: env.PHOENIX_PROGRAM_ID, operator, backup, sentinel, guardian };
}

export async function verifyProgram(config) {
  const result = await readVerifiedSolanaRpc('mainnet','getAccountInfo',[config.program,{
    commitment:'finalized',encoding:'base64',dataSlice:{offset:0,length:0},
  }],new AbortController().signal);
  if (result?.value?.executable !== true) throw new Error('The configured mainnet program is not executable.');
}

export async function readProjectTask(config, project, task, wallet, rpc = readVerifiedSolanaRpc) {
  if (!isSolanaAddress(task) || !isSolanaAddress(wallet)) throw new Error('Provide the public task and funding wallet addresses.');
  const observed = await rpc('mainnet', 'getAccountInfo', [task, {
    commitment: 'finalized', encoding: 'base64', dataSlice: { offset: 0, length: 374 },
  }], new AbortController().signal);
  const account = observed?.value;
  const slot = observed?.context?.slot;
  if (!Number.isSafeInteger(slot) || slot < 0 || account?.owner !== config.program || account.executable !== false ||
      account.data?.[1] !== 'base64' || typeof account.data[0] !== 'string' || account.data[0].length !== 500) {
    throw new Error('A finalized PHOENIX task account was not found at this address.');
  }
  const bytes = Uint8Array.from(atob(account.data[0]), char => char.charCodeAt(0));
  const state = decodeTask(bytes);
  const seed = Array.from(bytes.slice(8, 40), b => b.toString(16).padStart(2, '0')).join('');
  const keys = [40, 72, 104, 136, 168].map(offset => encodeAddress(bytes.slice(offset, offset + 32)));
  const [owner, operator, backup, sentinel, guardian] = keys;
  const workersMatch = (operator === config.operator && backup === config.backup) ||
    (operator === config.backup && backup === config.operator);
  if (seed !== project.task_seed || owner !== wallet || !workersMatch || sentinel !== config.sentinel || guardian !== config.guardian) {
    throw new Error('The finalized task does not match this project, funding wallet, and configured authorities.');
  }
  return { slot, state, authorities: { owner, operator, backup, sentinel, guardian } };
}

export function isFunded(state, budget) {
  return state.phase === 'Running' && state.escrowRemaining === budget &&
    state.escrowPaid === '0' && state.escrowRefunded === '0' && state.paymentNonce === '0';
}

export function isSettled(state, project) {
  return state.escrowRemaining === '0' && state.escrowPaid === project.budget && state.escrowRefunded === '0' &&
    state.paymentNonce === '1' && state.checkpointHash === project.delivery_hash;
}
