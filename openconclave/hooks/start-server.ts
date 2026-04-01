/**
 * SessionStart hook — starts OpenConclave server if not already running.
 * Browser is opened by the server itself (start.ts), not by this hook.
 */
import { resolve } from "path";
import { existsSync } from "fs";
import { spawn } from "bun";

const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const ocDir = process.env.OPENCONCLAVE_DIR ?? resolve(home, ".openconclave-app");
const port = process.env.OPENCONCLAVE_PORT ?? "4000";

// Check if server is already running
try {
  const res = await fetch(`http://localhost:${port}/api/health`);
  if (res.ok) {
    console.log(`OpenConclave running on port ${port}`);
    process.exit(0);
  }
} catch {}

// Check if OpenConclave is installed
if (!existsSync(resolve(ocDir, "packages/server/src/index.ts"))) {
  console.log("OpenConclave not installed. Run: curl -fsSL https://openconclave.com/install.sh | bash");
  process.exit(0);
}

// Walk up the process tree to find claude.exe / claude (the long-lived process).
// Hook runs as: claude.exe → bash → bash → ... → bun (this process)
// All intermediate shells die after the hook, so we need the actual Claude Code PID.
function findClaudePid(): number | undefined {
  try {
    let pid = process.pid;
    for (let i = 0; i < 10; i++) {
      let parentPid: number;
      let parentName: string;
      if (process.platform === "win32") {
        const r = Bun.spawnSync({
          cmd: ["powershell", "-NoProfile", "-Command",
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; "$($p.ParentProcessId)|$($p.Name)"`],
        });
        const [ppidStr, name] = r.stdout.toString().trim().split("|");
        parentPid = parseInt(ppidStr, 10);
        parentName = (name ?? "").toLowerCase();
      } else {
        const r = Bun.spawnSync({ cmd: ["ps", "-o", "ppid=,comm=", "-p", String(pid)] });
        const parts = r.stdout.toString().trim().split(/\s+/);
        parentPid = parseInt(parts[0], 10);
        parentName = (parts[1] ?? "").toLowerCase();
      }
      if (isNaN(parentPid) || parentPid <= 1) break;
      if (parentName.includes("claude")) return parentPid;
      pid = parentPid;
    }
  } catch {}
  return undefined;
}

const claudePid = findClaudePid();
const server = spawn({
  cmd: ["bun", "start"],
  cwd: ocDir,
  stdout: "ignore",
  stderr: "ignore",
  stdin: "ignore",
  detached: true,
  env: {
    ...process.env,
    ...(claudePid ? { OPENCONCLAVE_PARENT_PID: String(claudePid) } : {}),
  },
});
server.unref();

// Save PID so Stop hook can clean up
await Bun.write(resolve(ocDir, ".server.pid"), String(server.pid));

// Wait for server to be ready
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`);
    if (res.ok) {
      console.log(`OpenConclave started on port ${port}`);
      process.exit(0);
    }
  } catch {}
  await Bun.sleep(500);
}

console.log("OpenConclave server failed to start");
