// BUILD THE SDK BROWSER BUNDLE ON THE SAME LINUX NODE IMAGE CI USES.
//
// esbuild's minifier numbers symbols differently on Windows and Linux, so a Windows-built artifact cannot be
// compared byte-for-byte with the Linux artifact CI builds. This wrapper keeps a developer's working copy on the
// CI output: the repository is mounted read-write, dependencies are installed in the container, and the bundle is
// written back to assets/vendors/sdk/sdk-browser.js.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("docker", [
  "run", "--rm", "-v", ROOT + ":/src", "-w", "/src", "node:24.22.1",
  "sh", "-lc", "corepack enable >/dev/null 2>&1; pnpm install --frozen-lockfile && pnpm run build:sdk",
], { stdio: "inherit" });
if (result.error) {
  console.error("build:sdk:docker: " + result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
