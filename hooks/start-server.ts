/**
 * SessionStart hook — starts OpenConclave server and opens browser.
 * Runs via bun, works on all platforms.
 */
import { resolve } from "path";
import { existsSync } from "fs";
import { spawn } from "bun";

const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const ocDir = process.env.OPENCONCLAVE_DIR ?? resolve(home, ".openconclave-app");
const port = process.env.OPENCONCLAVE_PORT ?? "4000";
const clientPort = "5173";

// Check if server is already running
try {
  const res = await fetch(`http://localhost:${port}/api/health`);
  if (res.ok) {
    // Already running, just output success
    console.log(JSON.stringify({
      hookSpecificOutput: { message: `OpenConclave running on port ${port}` }
    }));
    process.exit(0);
  }
} catch {}

// Check if OpenConclave is installed
if (!existsSync(resolve(ocDir, "packages/server/src/index.ts"))) {
  console.log(JSON.stringify({
    hookSpecificOutput: { message: "OpenConclave not installed. Run: curl -fsSL https://openconclave.com/install.sh | bash" }
  }));
  process.exit(0);
}

// Start server in background
spawn({
  cmd: ["bun", "start"],
  cwd: ocDir,
  stdout: "ignore",
  stderr: "ignore",
  stdin: "ignore",
});

// Wait for server to be ready
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`);
    if (res.ok) {
      // Open browser
      const openCmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const openArgs = process.platform === "win32" ? ["/c", "start", `http://localhost:${clientPort}`] : [`http://localhost:${clientPort}`];
      spawn({ cmd: [openCmd, ...openArgs], stdout: "ignore", stderr: "ignore" });

      console.log(JSON.stringify({
        hookSpecificOutput: { message: `OpenConclave started. UI: http://localhost:${clientPort}` }
      }));
      process.exit(0);
    }
  } catch {}
  await Bun.sleep(500);
}

console.log(JSON.stringify({
  hookSpecificOutput: { message: "OpenConclave server failed to start" }
}));
