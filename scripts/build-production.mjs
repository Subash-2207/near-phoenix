import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = join(root, 'apps/solana-dashboard');
const service = join(root, 'apps/production');
const buildResult = spawnSync(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'build'], {
  cwd: app, stdio: 'inherit', env: { ...process.env, PHOENIX_ROOT_DEPLOY: '1' },
});
if (buildResult.status !== 0) throw new Error('The production dashboard build failed.');

const builds = join(service,'dist');
await mkdir(builds,{recursive:true});
const release = await mkdtemp(join(builds,'release-'));
const dist = join(release, 'dist');
await cp(join(app,'out'), join(dist,'client'), {recursive:true});
const worker = join(dist,'server/index.js');
await build({entryPoints:[join(service,'server/index.mjs')],outfile:worker,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'error'});
await cp(join(service,'migrations'),join(release,'migrations'),{recursive:true});
const site = process.env.PHOENIX_SITE_PROJECT_ID;
if (site) {
  assert.match(site,/^appgprj_[a-z0-9]+$/,'Use the existing Sites project ID.');
  const target = join(release,'.openai/hosting.json');
  await mkdir(dirname(target),{recursive:true});
  await writeFile(target, JSON.stringify({project_id:site,d1:{binding:'DB'}, r2:null},null,2)+'\n');
}
const pages = (await readdir(join(dist,'client'),{withFileTypes:true})).filter(file=>file.isDirectory() && !file.name.startsWith('_') && !['images','404'].includes(file.name));
for (const page of ['',...pages.map(file=>file.name)]) {
  const html = await readFile(join(dist,'client',page,'index.html'),'utf8');
  assert.doesNotMatch(html,/recovery drill|simulated funds|run sandbox drill/i);
}
assert.match(await readFile(join(dist,'client/projects/index.html'),'utf8'),/Project workspace/);
const browserWorker = await readFile(worker,'utf8');
assert.match(browserWorker,/createHandler\(/);
assert.doesNotMatch(browserWorker,/node:sqlite/);
console.log(release);
