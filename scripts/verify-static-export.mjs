import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "apps/solana-dashboard/out";
const sections = ["", "projects", "recovery", "security", "sentinel", "escrow", "evidence", "explorer", "analytics", "token-economics", "developers", "methodology", "whitepaper", "about", "wallet", "solana"];
for (const section of sections) {
  const body = readFileSync(join(root, section, "index.html"), "utf8");
  assert.ok(body.includes("PHOENIX") && body.includes("Solana"));
  assert.ok(!/Connect NEAR wallet|near-connect/.test(body), section + " still exposes the previous wallet");
  for (const [, href] of body.matchAll(/<(?:a|link|script|img)\b[^>]*\b(?:src|href)="(\/near-phoenix\/[^"#?]*)"/g)) {
    const output = href.slice("/near-phoenix/".length);
    const file = output === "" || href.endsWith("/") ? join(output, "index.html") : output;
    assert.ok(existsSync(join(root, file)), "Missing exported resource " + href);
  }
}
assert.ok(existsSync(join(root, "images/phoenix-recovery.png")));
assert.match(readFileSync(join(root, "whitepaper/index.html"), "utf8"), /Roles and authority/);
assert.match(readFileSync(join(root, "recovery/index.html"), "utf8"), /Resilience, connected/);
writeFileSync(join(root, ".nojekyll"), "");
console.log("Verified " + sections.length + " product routes, linked assets and the Solana-only wallet surface.");
