// Audit only the cargo-near artifacts deployed by integration-tests.
// This is an import regression check, not proof of sandbox execution.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// These host functions are present in nearcore 2.13.4 imports.rs and cover only
// this project's storage, context, native-transfer, Ed25519 verification and
// verified-callback needs. ed25519_verify is available in the pinned sandbox
// runtime (nearcore/near-vm-runner 0.38.0); do not remove signature checks to
// satisfy an older runtime.
const allowed = new Set([
  'value_return', 'read_register', 'register_len', 'storage_read', 'storage_write',
  'storage_remove', 'storage_has_key', 'storage_usage', 'input', 'panic_utf8',
  'block_timestamp', 'attached_deposit', 'predecessor_account_id', 'current_account_id',
  'account_balance', 'log_utf8', 'used_gas', 'prepaid_gas', 'promise_results_count',
  'promise_result', 'promise_return', 'promise_batch_create', 'promise_batch_then',
  'promise_batch_action_transfer', 'promise_batch_action_function_call_weight',
  'ed25519_verify',
]);
const artifacts = [];
for (const [crate, required] of [
  ['phoenix-core', ['new', 'register_agent', 'heartbeat', 'recover', 'contain', 'configure_stateflow', 'commit_checkpoint', 'approve_checkpoint_recovery', 'recover_checkpoint', 'get_stateflow', 'configure_sentinel', 'approve_signed_recovery', 'authorize_signed_action', 'anchor_security_audit']],
  ['rewind-vault', ['new', 'create_task', 'reserve_payment', 'settle_payment', 'refund', 'on_transfer', 'enable_task_fencing', 'advance_task_epoch', 'reserve_fenced_payment', 'approve_fenced_payment', 'settle_fenced_payment', 'configure_sentinel', 'approve_signed_payment', 'set_task_paused']],
]) {
  const name = crate.replaceAll('-', '_');
  const relative = `target/near/${name}/${name}.wasm`;
  const bytes = fs.readFileSync(path.join(root, relative));
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module).map(e => e.name);
  const unsupported = imports.filter(i => i.module !== 'env' || i.kind !== 'function' || !allowed.has(i.name));
  if (!imports.length || unsupported.length) {
    throw Error(`${relative}: unreviewed host imports: ${JSON.stringify(unsupported)}. Review SDK/runtime compatibility.`);
  }
  for (const method of required) {
    if (!exports.includes(method)) throw Error(`${relative}: missing ${method}`);
  }
  const record = { crate, path: relative, bytes: bytes.length, sha256: hash(bytes),
    sourceSha256: hash(fs.readFileSync(path.join(root, `contracts/${crate}/src/lib.rs`))), imports, exports };
  artifacts.push(record);
  console.log(`${relative}: ${bytes.length} bytes, SHA-256 ${record.sha256}, ${imports.length} reviewed imports`);
}
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts/near-wasm-manifest.json'), JSON.stringify({
  builder: 'cargo near build non-reproducible-wasm --locked --no-abi (wasm-opt enabled)',
  sdkDeclaredMinimumProtocolVersion: 88,
  cargoLockSha256: hash(fs.readFileSync(path.join(root, 'Cargo.lock'))),
  validation: 'Optimized artifact parsing, reviewed host import names and required exports. Runtime execution remains a separate check.',
  artifacts,
}, null, 2) + '\n');
