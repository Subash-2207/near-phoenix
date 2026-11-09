// Populate Cargo's local sparse cache over verified HTTPS when Schannel is unavailable.
// No proxy, alternative registry, TLS bypass, or system certificate changes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const home = path.resolve('.cargo-local');
const registry = 'index.crates.io-1949cf8c6b5b557f';
const index = path.join(home, 'registry/index', registry);
const cache = path.join(home, 'registry/cache', registry);
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw Error('Refusing disabled TLS validation');
async function download(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['index.crates.io','static.crates.io'].includes(parsed.hostname)) throw Error('Untrusted download origin');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error(`${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
fs.mkdirSync(index, {recursive:true});
fs.mkdirSync(cache, {recursive:true});
fs.writeFileSync(path.join(index,'config.json'), await download('https://index.crates.io/config.json'));
function indexPath(name) {
  const n=name.toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(n)) throw Error('Invalid crate name');
  return n.length===1?`1/${n}`:n.length===2?`2/${n}`:n.length===3?`3/${n[0]}/${n}`:`${n.slice(0,2)}/${n.slice(2,4)}/${n}`;
}
async function metadata(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw Error('Invalid crate name');
  const relative=indexPath(name);
  const data=await download(`https://index.crates.io/${relative}`);
  const parts=[Buffer.from([3,2,0,0,0]),Buffer.from('etag: "verified-https-cache"\0')];
  for(const line of data.toString('utf8').trim().split('\n')) {
    const item=JSON.parse(line);
    parts.push(Buffer.from(`${item.vers}\0${line}\0`));
  }
  const target=path.join(index,'.cache',relative);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,Buffer.concat(parts));
  console.log(`Index: ${name}`);
}
const update=process.argv[2];
const needsResolution=!!update || !fs.existsSync('Cargo.lock');
const resolutionArgs=update ? ['update','--offline','-p',update.split('@')[0],'--precise',update.split('@')[1]] : ['generate-lockfile','--offline'];
for(let i=0;needsResolution && i<1000;i++) {
  const result=spawnSync('cargo',resolutionArgs,{encoding:'utf8',env:{...process.env,CARGO_HOME:home},windowsHide:true});
  if(result.error) throw result.error;
  if(result.status===0) break;
  const missing=result.stderr.match(/no matching package named `([^`]+)` found/);
  if(!missing) throw Error(result.stderr);
  await metadata(missing[1]);
  if(i===999) throw Error('Resolution iteration limit exceeded');
}
const lock=fs.readFileSync('Cargo.lock','utf8');
const packages=lock.split('[[package]]').slice(1).filter(x=>x.includes('source = "registry+https://github.com/rust-lang/crates.io-index"')).map(block=>({name:block.match(/name = "([^"]+)"/)[1],version:block.match(/version = "([^"]+)"/)[1],checksum:block.match(/checksum = "([a-f0-9]{64})"/)[1]}));
// Restore metadata too, so a fresh local cache can consume the retained lockfile.
const names=[...new Set(packages.map(p=>p.name))];
let metadataNext=0;
await Promise.all(Array.from({length:6},async()=>{
  while(metadataNext<names.length) {
    const name=names[metadataNext++];
    if(!fs.existsSync(path.join(index,'.cache',indexPath(name)))) await metadata(name);
  }
}));
for(const item of packages) {
  const records=fs.readFileSync(path.join(index,'.cache',indexPath(item.name))).toString('utf8').split('\0').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  const record=records.find(record=>record.vers===item.version);
  if(!record || record.cksum!==item.checksum) throw Error(`Registry/lockfile checksum mismatch: ${item.name}`);
}
let next=0;
await Promise.all(Array.from({length:6},async()=>{
  while(next<packages.length) {
    const item=packages[next++];
    const target=path.join(cache,`${item.name}-${item.version}.crate`);
    const data=fs.existsSync(target)?fs.readFileSync(target):await download(`https://static.crates.io/crates/${item.name}/${item.name}-${item.version}.crate`);
    if(createHash('sha256').update(data).digest('hex')!==item.checksum) throw Error(`Checksum mismatch: ${item.name}`);
    fs.writeFileSync(target,data);
  }
}));
console.log(`Verified ${packages.length} crate archives against Cargo.lock SHA-256 checksums. Use CARGO_HOME=${home} and --offline --locked.`);
