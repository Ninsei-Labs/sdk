#!/usr/bin/env node
// A PUBLIC WORKFLOW MUST NOT CHECK OUT A PRIVATE REPOSITORY.
//
// sdk is public: every byte a workflow checks out into its workspace is reachable by any step in that workflow,
// and a later workflow edit by a compromised maintainer could copy it anywhere. Cross-repo tests therefore get
// only the one data file they need, downloaded through the API; they never clone relay, contracts, the node or
// the app into this tree.
//
// This guard is deliberately about the checkout boundary, not about secrets: a token can be readable by a step
// too, but a token is revocable and auditable, while a copied private tree is not.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const workflows = join(ROOT, ".github", "workflows");
const PRIVATE = ["relay", "router-escrow-evm", "rfq-node", "app", "local-stand", "internal-relay-service"];
const problems = [];
let scanned = 0;

for (const name of readdirSync(workflows)) {
  if (!/\.ya?ml$/i.test(name)) continue;
  scanned += 1;
  const text = readFileSync(join(workflows, name), "utf8");
  for (const repo of PRIVATE) {
    const checkout = new RegExp("repository:\\s*[\"']?Ninsei-Labs/" + repo + "(?![\\w-])", "i");
    if (checkout.test(text)) problems.push(name + ": checks out private repository " + repo);
    const clone = new RegExp("(?:git\\s+clone|https://github\\.com/Ninsei-Labs/" + repo + ")(?:\\.git)?", "i");
    if (clone.test(text)) problems.push(name + ": clones private repository " + repo);
  }
  // The local convenience path must not appear in CI: CI passes RELAY_VECTOR_FILE after downloading one file.
  if (/RELAY_REPO\s*:/i.test(text)) problems.push(name + ": sets RELAY_REPO; CI must pass RELAY_VECTOR_FILE only");
  if (/CROSS_REPO_TOKEN|RELAY_VECTOR_TOKEN|secrets\.CROSS_/i.test(text)) {
    problems.push(name + ": reads a cross-repository token; the public SDK must not hold one");
  }
}

if (problems.length) {
  console.error("CI BOUNDARY: FAILED");
  for (const problem of problems) console.error("  " + problem);
  process.exit(1);
}
console.log("ci boundary: " + scanned + " workflow(s), no private repository checkout");
