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
      "- channel:output — a workflow produced output for you. Read and present to user.",
      "- prompt:question — a workflow is asking YOU a question and waiting for your response.",
      "",
      "Core tools:",
      "- oc_list_workflows, oc_trigger_workflow, oc_get_run, oc_list_runs",
      "- oc_respond: respond to a pending prompt (REQUIRED when prompt:question events arrive)",
      "- oc_pending_prompts: list prompts waiting for response",
      "",
      "Workflow tools: Each enabled workflow with a toolName appears as its own tool.",
      "Call it directly to trigger the workflow — no need to use oc_trigger_workflow.",
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

defineTool("oc_list_workflows", "List all workflows in OpenConclave", {
  type: "object", properties: {},
}, async () => {
  const data = await ocApi("/workflows");
  const summary = data.workflows.map((w) => ({ id: w.id, name: w.name, enabled: w.enabled }));
  return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
});

defineTool("oc_trigger_workflow", "Trigger a workflow run. Always pass your current working directory as cwd so agents run in the correct project.", {
  type: "object",
  properties: {
    workflow_id: { type: "string", description: "The workflow ID to trigger" },
    payload: { type: "object", description: "Optional payload data" },
    cwd: { type: "string", description: "Your current working directory — agents will run here" },
  },
  required: ["workflow_id", "cwd"],
}, async ({ workflow_id, payload, cwd }) => {
  const enrichedPayload = { ...(payload ?? {}), ...(cwd ? { _callerCwd: cwd } : {}) };
  const data = await ocApi(`/workflows/${workflow_id}/run`, "POST", { payload: enrichedPayload });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

defineTool("oc_get_run", "Get details of a specific workflow run including tasks and events", {
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

defineTool("oc_list_runs", "List recent workflow runs", {
  type: "object",
  properties: { limit: { type: "number", description: "Max results (default 10)" } },
}, async ({ limit }) => {
  const data = await ocApi(`/runs?limit=${limit ?? 10}`);
  const summary = data.runs.map((r) => ({ id: r.id, status: r.status, workflowId: r.workflowId, createdAt: r.createdAt }));
  return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
});

defineTool("oc_respond", "Respond to a pending prompt question from a workflow. Use this to send your response so the workflow can continue.", {
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

// ── Dynamic workflow tools ──────────────────────────────────

const registeredWorkflowTools = new Set();

async function syncWorkflowTools() {
  try {
    const data = await ocApi("/workflows");
    const seen = new Set();
    const oldRegistered = new Set(registeredWorkflowTools);

    for (const wf of data.workflows) {
      if (!wf.enabled) continue;
      const def = wf.definition ?? {};
      const toolName = def.toolName ?? wf.toolName;
      if (!toolName) continue;

      seen.add(toolName);
      if (!registeredWorkflowTools.has(toolName)) {
        const description = def.description ?? wf.description ?? `Run workflow: ${wf.name}`;
        const workflowId = String(wf.id);

        defineTool(toolName, `${description}. Always pass your current working directory as cwd so agents run in the correct project.`, {
          type: "object",
          properties: {
            input: { type: "string", description: "Input data to pass to the workflow trigger" },
            cwd: { type: "string", description: "Your current working directory — agents will run here" },
          },
          required: ["cwd"],
        }, async ({ input, cwd }) => {
          const payload = { ...(input ? { input } : {}), ...(cwd ? { _callerCwd: cwd } : {}) };
          const result = await ocApi(`/workflows/${workflowId}/run`, "POST", { payload });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });
        registeredWorkflowTools.add(toolName);
      }
    }

    for (const t of registeredWorkflowTools) {
      if (!seen.has(t)) {
        registeredWorkflowTools.delete(t);
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
    console.error("[channel] syncWorkflowTools error:", err);
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

await syncWorkflowTools();
console.error(`[channel] synced ${registeredWorkflowTools.size} workflow tools`);

const transport = new StdioServerTransport();
await server.connect(transport);

// ── WebSocket ───────────────────────────────────────────────

function connectWS() {
  try {
    const ws = new WebSocket(OC_WS_URL);

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
          if (data.data?.workflowName) meta.workflow_name = data.data.workflowName;
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

        // Resync tools when workflows change
        if (eventType === "workflow:updated" || eventType === "workflow:created" || eventType === "workflow:deleted") {
          await syncWorkflowTools();
        }
      } catch {}
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
