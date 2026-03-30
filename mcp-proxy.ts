/**
 * Thin MCP proxy — finds the OpenConclave installation and spawns its MCP server.
 * This runs inside the plugin directory (${CLAUDE_PLUGIN_ROOT}).
 */
import { resolve } from "path";
import { existsSync } from "fs";

// Find OpenConclave installation
const candidates = [
  process.env.OPENCONCLAVE_DIR,
  resolve(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".openconclave-app"),
  resolve(process.cwd(), "packages/server/src/mcp/server.ts") ? process.cwd() : null,
].filter(Boolean) as string[];

let ocRoot: string | null = null;
for (const dir of candidates) {
  const mcpPath = resolve(dir, "packages/server/src/mcp/server.ts");
  if (existsSync(mcpPath)) {
    ocRoot = dir;
    break;
  }
}

if (!ocRoot) {
  console.error("OpenConclave not found. Install: curl -fsSL https://openconclave.com/install.sh | bash");
  process.exit(1);
}

// Spawn the actual MCP server
const mcpPath = resolve(ocRoot, "packages/server/src/mcp/server.ts");
const proc = Bun.spawn(["bun", "run", mcpPath], {
  cwd: ocRoot,
  stdio: ["inherit", "inherit", "inherit"],
});

await proc.exited;
