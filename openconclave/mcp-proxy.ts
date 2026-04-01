/**
 * Thin MCP proxy — finds the OpenConclave server code and runs it.
 * Spawns the real MCP server as a child with inherited stdio so
 * import.meta.main is true and node_modules resolve from the app dir.
 */
import { resolve } from "path";
import { existsSync } from "fs";
import { spawn } from "bun";

const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const candidates = [
  process.env.OPENCONCLAVE_DIR,
  resolve(home, ".openconclave-app"),
].filter(Boolean) as string[];

let ocDir: string | null = null;
for (const dir of candidates) {
  const p = resolve(dir, "packages/server/src/mcp/server.ts");
  if (existsSync(p)) {
    ocDir = dir;
    break;
  }
}

if (!ocDir) {
  console.error("OpenConclave not found. Install: curl -fsSL https://openconclave.com/install.sh | bash");
  process.exit(1);
}

// Spawn bun with the MCP server — inherits stdio for JSON-RPC transport
const mcpScript = resolve(ocDir, "packages/server/src/mcp/server.ts");
const proc = spawn({
  cmd: ["bun", "run", mcpScript],
  cwd: ocDir,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

// Exit when child exits
const code = await proc.exited;
process.exit(code);
