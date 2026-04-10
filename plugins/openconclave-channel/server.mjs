import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const OC_URL = process.env.OPENCONCLAVE_URL ?? "http://localhost:4000";
const OC_WS_URL = process.env.OPENCONCLAVE_WS_URL ?? "ws://localhost:4000";

// ── MCP Server ──────────────────────────────────────────────

const server = new Server(
  { name: "openconclave-channel", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: [
      'Events from OpenConclave arrive as <channel source="openconclave" event_type="..." ...>.',
      "",
      "Event types:",
      "- channel:output — a conclave produced output for you. Read and present to user.",
      "- prompt:question — a conclave is asking YOU a question and waiting for your response.",
      "",
      "Core tools:",
      "- oc_list_conclaves, oc_trigger_conclave, oc_get_run, oc_list_runs",
      "- oc_respond: respond to a pending prompt (REQUIRED when prompt:question events arrive)",
      "- oc_pending_prompts: list prompts waiting for response",
      "",
      "Conclave tools: Each enabled conclave with a toolName appears as its own tool.",
      "Call it directly to trigger the conclave — no need to use oc_trigger_conclave.",
      "",
      "IMPORTANT: When you receive a prompt:question event, respond immediately using oc_respond.",
    ].join("\n"),
  }
);

// ── API helper ──────────────────────────────────────────────

async function ocApi(path, method = "GET", body) {
  const res = await fetch(`${OC_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

// ── Tool registry ───────────────────────────────────────────

const tools = new Map();

function defineTool(name, description, schema, handler) {
  tools.set(name, { name, description, schema, handler });
}

// ── Core tools ──────────────────────────────────────────────

defineTool("oc_list_conclaves", "List all conclaves in OpenConclave", {
  type: "object", properties: {},
}, async () => {
  const data = await ocApi("/conclaves");
  const summary = data.conclaves.map((w) => ({ id: w.id, name: w.name, enabled: w.enabled }));
  return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
});

defineTool("oc_trigger_conclave", "Trigger a conclave run. Always pass your current working directory as cwd so agents run in the correct project.", {
  type: "object",
  properties: {
    conclave_id: { type: "string", description: "The conclave ID to trigger" },
    payload: { type: "object", description: "Optional payload data" },
    cwd: { type: "string", description: "Your current working directory — agents will run here" },
  },
  required: ["conclave_id", "cwd"],
}, async ({ conclave_id, payload, cwd }) => {
  const enrichedPayload = { ...(payload ?? {}), ...(cwd ? { _callerCwd: cwd } : {}) };
  const data = await ocApi(`/conclaves/${conclave_id}/run`, "POST", { payload: enrichedPayload });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

defineTool("oc_get_run", "Get details of a specific conclave run including tasks and events", {
  type: "object",
  properties: { run_id: { type: "string", description: "The run ID" } },
  required: ["run_id"],
}, async ({ run_id }) => {
  const data = await ocApi(`/runs/${run_id}`);
  const tasks = data.tasks.map((t) => ({
    id: t.id, nodeId: t.nodeId, status: t.status, model: t.model,
    prompt: typeof t.prompt === "string" ? t.prompt.slice(0, 100) : t.prompt,
    output: typeof t.output === "string" ? t.output.slice(0, 300) : t.output,
    costUsd: t.costUsd,
  }));
  return { content: [{ type: "text", text: JSON.stringify({ run: data.run, tasks }, null, 2) }] };
});

defineTool("oc_list_runs", "List recent conclave runs", {
  type: "object",
  properties: { limit: { type: "number", description: "Max results (default 10)" } },
}, async ({ limit }) => {
  const data = await ocApi(`/runs?limit=${limit ?? 10}`);
  const summary = data.runs.map((r) => ({ id: r.id, status: r.status, conclaveId: r.conclaveId, createdAt: r.createdAt }));
  return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
});

defineTool("oc_respond", "Respond to a pending prompt question from a conclave. Use this to send your response so the conclave can continue.", {
  type: "object",
  properties: {
    run_id: { type: "string", description: "The run ID" },
    node_id: { type: "string", description: "The prompt node ID" },
    response: { type: "string", description: "Your response to the question" },
  },
  required: ["run_id", "node_id", "response"],
}, async ({ run_id, node_id, response }) => {
  const data = await ocApi("/prompts/respond", "POST", { runId: run_id, nodeId: node_id, response });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

defineTool("oc_pending_prompts", "List all pending prompt questions waiting for responses", {
  type: "object", properties: {},
}, async () => {
  const data = await ocApi("/prompts/pending");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// ── Dynamic conclave tools ──────────────────────────────────

const registeredConclaveTools = new Set();

async function syncConclaveTools() {
  try {
    const data = await ocApi("/conclaves");
    const seen = new Set();
    const oldRegistered = new Set(registeredConclaveTools);

    for (const wf of data.conclaves) {
      if (!wf.enabled) continue;
      const def = wf.definition ?? {};
      const toolName = def.toolName ?? wf.toolName;
      if (!toolName) continue;

      seen.add(toolName);
      if (!registeredConclaveTools.has(toolName)) {
        const description = def.description ?? wf.description ?? `Run conclave: ${wf.name}`;
        const conclaveId = String(wf.id);

        defineTool(toolName, `${description}. Always pass your current working directory as cwd so agents run in the correct project.`, {
          type: "object",
          properties: {
            input: { type: "string", description: "Input data to pass to the conclave trigger" },
            cwd: { type: "string", description: "Your current working directory — agents will run here" },
          },
          required: ["cwd"],
        }, async ({ input, cwd }) => {
          const payload = { ...(input ? { input } : {}), ...(cwd ? { _callerCwd: cwd } : {}) };
          const result = await ocApi(`/conclaves/${conclaveId}/run`, "POST", { payload });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
        registeredConclaveTools.add(toolName);
      }
    }

    for (const t of registeredConclaveTools) {
      if (!seen.has(t)) {
        registeredConclaveTools.delete(t);
        tools.delete(t);
      }
    }

    if (seen.size !== oldRegistered.size ||
        [...seen].some((t) => !oldRegistered.has(t)) ||
        [...oldRegistered].some((t) => !seen.has(t))) {
      try {
        await server.notification({ method: "notifications/tools/list_changed" });
      } catch {}
    }
  } catch (err) {
    console.error("[channel] syncConclaveTools error:", err);
  }
}

// ── MCP handlers ────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...tools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.schema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.get(name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  try {
    return await tool.handler(args ?? {});
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message ?? err}` }], isError: true };
  }
});

// ── Sync & Connect ──────────────────────────────────────────

await syncConclaveTools();
console.error(`[channel] synced ${registeredConclaveTools.size} conclave tools`);

const transport = new StdioServerTransport();
await server.connect(transport);

// ── WebSocket ───────────────────────────────────────────────

let currentWS = null;

function forceReconnect() {
  if (currentWS) {
    try { currentWS.close(); } catch {}
    currentWS = null;
  }
  connectWS();
}

defineTool("ws_reconnect", "Force reconnect the WebSocket to the OpenConclave server. Use when channel notifications stop arriving.", {
  type: "object", properties: {},
}, async () => {
  forceReconnect();
  return { content: [{ type: "text", text: "WebSocket reconnection initiated" }] };
});

function connectWS() {
  try {
    const ws = new WebSocket(OC_WS_URL);
    currentWS = ws;

    ws.onopen = () => {
      console.error("[channel] WS connected to", OC_WS_URL);
      ws.send(JSON.stringify({ type: "subscribe", topics: ["dashboard"] }));
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        const eventType = data.type;

        if (eventType === "channel:output" || eventType === "prompt:question") {
          const meta = {
            event_type: eventType,
            run_id: String(data.runId ?? ""),
          };
          if (data.data?.conclaveName) meta.conclave_name = data.data.conclaveName;
          if (data.data?.nodeLabel) meta.node_label = data.data.nodeLabel;
          if (data.data?.senderNode) meta.sender_node = data.data.senderNode;

          const content = typeof data.data === "string"
            ? data.data
            : JSON.stringify(data.data ?? {}, null, 2);

          await server.notification({
            method: "notifications/claude/channel",
            params: { content, meta },
          });
        }

        // Resync tools when conclaves change
        if (eventType === "conclave:updated" || eventType === "conclave:created" || eventType === "conclave:deleted") {
          await syncConclaveTools();
        }
      } catch (err) {
        console.error("[channel] WS message handler error:", err);
      }
    };

    ws.onclose = () => {
      console.error("[channel] WS closed, reconnecting in 5s...");
      setTimeout(connectWS, 5000);
    };
    ws.onerror = () => {};
  } catch {
    setTimeout(connectWS, 5000);
  }
}

connectWS();
