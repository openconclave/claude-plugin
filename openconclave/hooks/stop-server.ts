/**
 * Stop hook — kills the OpenConclave server that was started by the SessionStart hook.
 */
import { resolve } from "path";
import { existsSync, unlinkSync, readFileSync } from "fs";
import { spawnSync } from "bun";

const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const ocDir = process.env.OPENCONCLAVE_DIR ?? resolve(home, ".openconclave-app");
const pidFile = resolve(ocDir, ".server.pid");

if (!existsSync(pidFile)) process.exit(0);

const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
if (isNaN(pid)) {
  try { unlinkSync(pidFile); } catch {}
  process.exit(0);
}

try {
  if (process.platform === "win32") {
    // /T kills the entire process tree (bun start spawns children)
    spawnSync({ cmd: ["taskkill", "/PID", String(pid), "/F", "/T"] });
  } else {
    // Kill process group (negative PID) to get children too
    process.kill(-pid, "SIGTERM");
  }
} catch {}

try { unlinkSync(pidFile); } catch {}
