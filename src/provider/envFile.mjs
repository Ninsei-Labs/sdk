// THE SERVICE SETTINGS FILE: WHERE IT LIES AND HOW IT IS READ.
//
// The module deliberately imports NOTHING from config.mjs: the entry point connects it BEFORE the config loads, so that
// the values get into the environment in time. config.mjs reads process.env at module load time, and static
// imports in ESM run before any code of the file - so 'read the file, then import the config' is
// possible only through a dynamic import and only from a separate module.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// WHERE TO LOOK WHEN THE FLAG IS NOT GIVEN: the current directory (the command is run from the node tree), then rfq/ under it (the layout of the tree this node was cut from)
// (the same run from the repository root), then .env - that is also a frequent name for a settings file. What was found
// is printed: a silent read of 'some' file is exactly the case where people later look for why the settings are wrong.
//
// ORDER: THE LOCAL FILE OUTRANKS THE PRODUCTION ONE. The local contour puts its settings BESIDE the production ones
// (rfq.env.local), and while the search went from the plain name to .local, the developer tool picked up the production
// file: the wallet path /opt/ninsei/..., the production price feed and its age - and refused with 'nothing to price the order with' where
// the settings were in place (the quote checks fell exactly on this, and `npm run payout` with them).
// The reverse order can err in one direction only: on the server there is no .local file at all, and the production
// one remains the only one. An explicit --env= still outranks everything.
export const ENV_CANDIDATES = ["rfq.env.local", "rfq.env.local", "rfq.env", "rfq.env", ".env.local", ".env"];

export function findEnvFile(cwd, candidates = ENV_CANDIDATES) {
  for (const rel of candidates) {
    const full = join(cwd, rel);
    if (existsSync(full)) return full;
  }
  return null;
}

// A PATH OF A FOREIGN MACHINE IN A SETTINGS FILE IS AN ERROR, NOT A SETTING.
//
// The trap was found in battle on 25.09.2026. The local files (*.env.local) travelled to the server with the directory upload
// (the documented rsync commands had no --exclude '*.env.local'), the tool honestly took the local file -
// it outranks the production one, see below - start directory and the result was:
//
//     /opt/ninsei/keys
//
// The check is one-sided DELIBERATELY: the reverse case - production paths /opt/... on a developer machine - is legitimate,
// because the repository holds copies of the production files, and they must be readable. The function is pure: the platform comes
// as a parameter, so its behaviour is checkable on any machine.
export function foreignPathProblem(file, values, platform = process.platform) {
  if (platform === "win32") return null;
  for (const [key, value] of Object.entries(values || {})) {
    const v = String(value).trim();
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(v)) return { file, key, value: v };
  }
  return null;
}

export function foreignPathMessage(p) {
  return "settings file " + p.file + " sets a Windows path in setting " + p.key + " (" + p.value
    + "), and the system is not Windows. This is how a local file (*.env.local) copied from a developer "
    + "machine looks: it must not be on the server, the service reads <service>/<service>.env. Delete the local "
    + "file and repeat.";
}

// We read by the systemd rules: comments and broken lines are skipped, export is stripped, quotes are stripped,
// spaces are trimmed.
export function readEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  // The file is read, but the values may be FROM A FOREIGN MACHINE - then it is a refusal, not a setting.
  const foreign = foreignPathProblem(path, out);
  if (foreign) throw new Error(foreignPathMessage(foreign));
  return out;
}

// WE APPLY THE FILE TO THE ENVIRONMENT. The file is the SERVICE's configuration, so it outranks what happened to be
// exported in the shell; explicit command flags are parsed later and outrank both. We return the key names
// without values: printing setting values into the log is not allowed.
// VARIABLE SUBSTITUTION LIVES HERE, NOT IN EVERY TOOL. In the local file the settings are written as
// ${STACK_DATA}/rfq-wallet.json, and they are substituted by the launcher (the stack itself). A tool that does not do this
// sees literally "${STACK_DATA}" - and the consequences are not only 'wallet not found': by the same literal path it
// creates an EMPTY quote database and then reports 'the log is empty' on a live contour, that is, the refusal looks like
// absence of data. Before, the substitution was copied into one tool; a copy is a sign that the place is shared.
export function substituteEnvVars(value, { dataDir, root }) {
  return String(value)
    .replace(/\$\{STACK_DATA\}/g, dataDir)
    .replace(/\$\{ROOT\}/g, root);
}

export function applyEnvFile(path, target = process.env) {
  const values = readEnvFile(path);
  const dataDir = target.STACK_DATA || join(tmpdir(), "ninsei-stack");
  const root = target.ROOT || process.cwd();
  const substituted = {};
  for (const [k, v] of Object.entries(values)) substituted[k] = substituteEnvVars(v, { dataDir, root });
  // THE SUBSTITUTION MAY BRING A FOREIGN PATH: ${STACK_DATA} expands to the directory of THE machine where it is run.
  // We check after the substitution too - that is exactly how the production case with /opt/ninsei/ surfaced.
  const foreign = foreignPathProblem(path, substituted);
  if (foreign) throw new Error(foreignPathMessage(foreign));
  for (const [k, v] of Object.entries(substituted)) target[k] = v;
  return Object.keys(values);
}
