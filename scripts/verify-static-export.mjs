import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('apps/dashboard/out');
const basePath = '/near-phoenix';
const sections = ['', 'recovery', 'security', 'escrow', 'sentinel', 'explorer', 'analytics', 'token-economics', 'methodology', 'developers', 'about'];
function exportedFile(url) {
  const pathname = new URL(url, 'https://subash-2207.github.io').pathname;
  assert.ok(pathname.startsWith(`${basePath}/`), `Asset or page escaped basePath: ${url}`);
  const relative = decodeURIComponent(pathname.slice(basePath.length + 1));
  const file = path.resolve(root, relative);
  assert.ok(file === root || file.startsWith(root + path.sep), 'Export path escaped output directory');
  return pathname.endsWith('/') ? path.join(file, 'index.html') : file;
}
let assets = 0;
for (const section of sections) {
  const html = fs.readFileSync(path.join(root, section, 'index.html'), 'utf8');
  assert.ok(html.includes('Monolith Studio'), `Wrong project exported at ${section}`);
  assert.equal(html.split('class="px-shell px-monolith"').length - 1, 1, `Duplicate workspace at ${section}`);
  for (const match of html.matchAll(/<(?:a|link|script|img)\b[^>]*\b(?:src|href)="(\/[^"#]*)"[^>]*>/g)) {
    if (/rel="(?:preconnect|dns-prefetch)"/.test(match[0])) continue;
    const target = exportedFile(match[1]);
    assert.ok(fs.existsSync(target), `Missing exported resource ${match[1]}`);
    assets++;
  }
}
for (const name of fs.readdirSync(path.join(root, '_next/static/chunks'))) {
  if (!name.endsWith('.css')) continue;
  const css = fs.readFileSync(path.join(root, '_next/static/chunks', name), 'utf8');
  for (const match of css.matchAll(/url\(["']?(\/[^"')]+)["']?\)/g)) {
    assert.ok(fs.existsSync(exportedFile(match[1])), `Missing CSS image ${match[1]}`);
    assets++;
  }
}
fs.writeFileSync(path.join(root, '.nojekyll'), '');
console.log(`PASS: ${sections.length} exported routes, one workspace per route, ${assets} resource references, basePath and .nojekyll.`);
