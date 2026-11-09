// Build NEAR host-path WASM without changing the user's installed Rust toolchain.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function run(command, args, options={}) {
  const result=spawnSync(command,args,{windowsHide:true,...options});
  if(result.error) throw result.error;
  if(result.status!==0) throw Error(`${command} ${args.join(' ')} exited ${result.status}`);
  return result;
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
const sysroot=run('rustc',['--print','sysroot'],{encoding:'utf8'}).stdout.trim();
const compiler=run('rustc',['-vV'],{encoding:'utf8'}).stdout.trim();
let wasmSysroot=sysroot;
const target='wasm32-unknown-unknown';
if(!fs.existsSync(path.join(sysroot,'lib/rustlib',target,'lib'))) {
  const manifest=fs.readFileSync(path.join(sysroot,'lib/rustlib/multirust-channel-manifest.toml'),'utf8');
  const section=manifest.split(`[pkg.rust-std.target.${target}]`)[1]?.split('\n[')[0];
  if(!section) throw Error('Matching Rust WASM component missing from installed toolchain manifest');
  const url=section.match(/xz_url = "([^"]+)"/)?.[1];
  const checksum=section.match(/xz_hash = "([a-f0-9]{64})"/)?.[1];
  if(!url || !checksum || new URL(url).origin!=='https://static.rust-lang.org') throw Error('Untrusted Rust component');
  const directory=path.resolve('.rust-local');
  const archive=path.join(directory,path.basename(new URL(url).pathname));
  fs.mkdirSync(directory,{recursive:true});
  let data=fs.existsSync(archive)?fs.readFileSync(archive):undefined;
  if(!data) {
    if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0') throw Error('Refusing disabled TLS validation');
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
    if(!response.ok) throw Error(`Rust component HTTP ${response.status}`);
    data=Buffer.from(await response.arrayBuffer());
  }
  if(sha256(data)!==checksum) throw Error('Rust component checksum mismatch');
  fs.writeFileSync(archive,data);
  const component=path.basename(archive,'.tar.xz');
  wasmSysroot=path.join(directory,component,`rust-std-${target}`);
  if(!fs.existsSync(path.join(wasmSysroot,'lib/rustlib',target,'lib'))) {
    run(process.platform==='win32'?'tar.exe':'tar',['-xf',archive,'-C',directory],{stdio:'inherit'});
  }
  console.log(`Verified Rust WASM component SHA-256: ${checksum}`);
}
const env={...process.env,
  ...(fs.existsSync('.cargo-local/registry/index') && !process.env.CARGO_HOME
    ? {CARGO_HOME:path.resolve('.cargo-local')} : {}),
  CARGO_ENCODED_RUSTFLAGS:['--cfg','near','--sysroot',wasmSysroot].join('\x1f')};
// With --target, Cargo applies these flags only to the target, not host build scripts.
run('cargo',['build','--workspace','--target',target,'--release','--offline','--locked'],{env,stdio:'inherit'});
const artifacts=[];
for(const [crate,required] of [
  ['phoenix-core',['new','heartbeat','recover','contain']],
  ['rewind-vault',['new','create_task','reserve_payment','settle_payment','refund','on_transfer','mark_uncertain','set_safe_mode']],
]) {
  const relative=`target/${target}/release/${crate.replaceAll('-','_')}.wasm`;
  const bytes=fs.readFileSync(relative);
  const module=new WebAssembly.Module(bytes);
  const imports=WebAssembly.Module.imports(module);
  const exports=WebAssembly.Module.exports(module).map(e=>e.name);
  if(imports.length===0 || imports.some(i=>i.module!=='env' || i.kind!=='function')) throw Error(`${crate}: unexpected host imports`);
  for(const name of required) if(!exports.includes(name)) throw Error(`${crate}: missing export ${name}`);
  artifacts.push({crate,path:relative,bytes:bytes.length,sha256:sha256(bytes),imports,exports,
    sourceSha256:sha256(fs.readFileSync(`contracts/${crate}/src/lib.rs`))});
  console.log(`${path.resolve(relative)} (${bytes.length} bytes; SHA-256 ${sha256(bytes)})`);
}
fs.mkdirSync('artifacts',{recursive:true});
fs.writeFileSync('artifacts/wasm-manifest.json',JSON.stringify({
  compiler,target,cfg:'near',nearSdk:'5.30.0',minProtocolVersion:88,
  cargoLockSha256:sha256(fs.readFileSync('Cargo.lock')),
  validation:'Module parsing, NEAR env-only imports and required exports checked; not sandbox execution or reproducible-build attestation.',
  artifacts,
},null,2)+'\n');
