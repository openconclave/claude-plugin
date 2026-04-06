import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const OC_URL = process.env.OPENCONCLAVE_URL ?? "http://localhost:4000";

async function ocApi(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(`${OC_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

const NODE_TYPES = ["trigger", "agent", "condition", "code", "merge", "prompt", "output", "file", "discussion"] as const;

const server = new McpServer({
  name: "openconclave-dev",
  version: "0.1.0",
});

// ── Workflows ──────────────────────────────────────────────

server.tool(
  "list_workflows",
  "List all workflows in OpenConclave",
  {},
  async () => {
    const data = await ocApi("/workflows") as { workflows: Array<Record<string, unknown>> };
    const summary = data.workflows.map((w) => {
      const def = w.definition as Record<string, unknown> | null;
      const nodes = (def?.nodes ?? []) as unknown[];
      return {
        id: w.id,
        name: w.name,
        toolName: (def?.toolName ?? null) as string | null,
        description: w.description ?? null,
        nodes: nodes.length,
      };
    });
    return { content: [{ type: "text", text: JSON.stringify(summary) }] };
  }
);

server.tool(
  "get_workflow",
  "Get a workflow summary: metadata, node list, and edges",
  { workflowId: z.string().describe("The workflow ID") },
  async ({ workflowId }) => {
    try {
      const data = await ocApi(`/workflows/${workflowId}`) as Record<string, unknown>;
      const def = data.definition as Record<string, unknown> | null;
      const rawNodes = (def?.nodes ?? []) as Array<Record<string, unknown>>;
      const nodes = rawNodes.map((n) => {
        const d = n.data as Record<string, unknown>;
        return { id: n.id, label: d.label, type: d.type };
      });
      const rawEdges = (def?.edges ?? []) as Array<Record<string, unknown>>;
      const edges = rawEdges.map((e) => {
        const edge: Record<string, unknown> = { source: e.source, target: e.target };
        if (e.sourceHandle) edge.sourceHandle = e.sourceHandle;
        if (e.label) edge.label = e.label;
        return edge;
      });
      const summary = {
        id: data.id,
        name: data.name,
        toolName: (def?.toolName ?? null) as string | null,
        description: data.description ?? null,
        nodes,
        edges,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    } catch {
      return { content: [{ type: "text", text: "Workflow not found" }], isError: true };
    }
  }
);

server.tool(
  "get_node",
  "Get full details of a single node in a workflow",
  {
    workflowId: z.string().describe("The workflow ID"),
    nodeId: z.string().describe("The node ID"),
  },
  async ({ workflowId, nodeId }) => {
    try {
      const data = await ocApi(`/workflows/${workflowId}`) as Record<string, unknown>;
      const def = data.definition as Record<string, unknown> | null;
      const rawNodes = (def?.nodes ?? []) as Array<Record<string, unknown>>;
      const node = rawNodes.find((n) => n.id === nodeId);
      if (!node) return { content: [{ type: "text", text: "Node not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(node) }] };
    } catch {
      return { content: [{ type: "text", text: "Workflow not found" }], isError: true };
    }
  }
);

server.tool(
  "add_node",
  "Add a new node to a workflow, optionally connecting it",
  {
    workflowId: z.string().describe("The workflow ID"),
    type: z.enum(NODE_TYPES).describe("Node type"),
    label: z.string().describe("Node label"),
    config: z.record(z.unknown()).optional().describe("Node config (e.g. {runtime:'python',code:'...'} for code, {model:'sonnet'} for agent)"),
    position: z.object({ x: z.number(), y: z.number() }).optional().describe("Canvas position (default: {x:0,y:0})"),
    connectFrom: z.string().optional().describe("Source node ID to add an edge FROM -> this new node"),
    connectTo: z.string().optional().describe("Target node ID to add an edge this new node -> TO"),
  },
  async ({ workflowId, type, label, config, position, connectFrom, connectTo }) => {
    try {
      const data = await ocApi(`/workflows/${workflowId}`) as Record<string, unknown>;
      const def = data.definition as Record<string, unknown>;
      const nodes = [...(def.nodes ?? []) as Array<Record<string, unknown>>];
      const edges = [...(def.edges ?? []) as Array<Record<string, unknown>>];
      const nodeIds = new Set(nodes.map((n) => n.id as string));

      const nodeId = `${type}_${Date.now()}`;

      if (connectFrom && !nodeIds.has(connectFrom)) {
        return { content: [{ type: "text", text: `connectFrom node "${connectFrom}" not found` }], isError: true };
      }
      if (connectTo && !nodeIds.has(connectTo)) {
        return { content: [{ type: "text", text: `connectTo node "${connectTo}" not found` }], isError: true };
      }

      nodes.push({
        id: nodeId,
        type,
        position: position ?? { x: 0, y: 0 },
        data: { label, type, config: config ?? {} },
      });

      if (connectFrom) {
        edges.push({ id: `e_${connectFrom}_${nodeId}`, source: connectFrom, target: nodeId, sourceHandle: "bottom" });
      }
      if (connectTo) {
        edges.push({ id: `e_${nodeId}_${connectTo}`, source: nodeId, target: connectTo, sourceHandle: "bottom" });
      }

      await ocApi(`/workflows/${workflowId}`, "PUT", { nodes, edges });

      return { content: [{ type: "text", text: JSON.stringify({ workflowId, nodeId, status: "added" }) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Failed: ${message}` }], isError: true };
    }
  }
);

server.tool(
  "update_node",
  "Update a node's properties and/or connections in a workflow",
  {
    workflowId: z.string().describe("The workflow ID"),
    nodeId: z.string().describe("The node ID to update"),
    label: z.string().optional().describe("New node label"),
    config: z.record(z.unknown()).optional().describe("Config fields to merge with existing config"),
    addEdges: z.array(z.object({
      source: z.string(),
      target: z.string(),
      sourceHandle: z.string().optional(),
      label: z.string().optional(),
    })).optional().describe("Edges to add"),
    removeEdges: z.array(z.object({
      source: z.string(),
      target: z.string(),
    })).optional().describe("Edges to remove (matched by source+target)"),
  },
  async ({ workflowId, nodeId, label, config, addEdges, removeEdges }) => {
    try {
      const data = await ocApi(`/workflows/${workflowId}`) as Record<string, unknown>;
      const def = data.definition as Record<string, unknown>;
      const nodes = [...(def.nodes ?? []) as Array<Record<string, unknown>>];
      let edges = [...(def.edges ?? []) as Array<Record<string, unknown>>];

      const nodeIndex = nodes.findIndex((n) => n.id === nodeId);
      if (nodeIndex === -1) {
        return { content: [{ type: "text", text: `Node "${nodeId}" not found in workflow ${workflowId}` }], isError: true };
      }

      const node = { ...nodes[nodeIndex] };
      const nodeData = { ...(node.data as Record<string, unknown>) };
      node.data = nodeData;
      nodes[nodeIndex] = node;

      if (label !== undefined) nodeData.label = label;

      if (config) {
        const existing = (nodeData.config ?? {}) as Record<string, unknown>;
        nodeData.config = { ...existing, ...config };
      }

      const nodeIds = new Set(nodes.map((n) => n.id as string));

      if (removeEdges) {
        for (const re of removeEdges) {
          edges = edges.filter((e) => !(e.source === re.source && e.target === re.target));
        }
      }

      if (addEdges) {
        for (const ae of addEdges) {
          if (!nodeIds.has(ae.source)) {
            return { content: [{ type: "text", text: `Invalid edge: source "${ae.source}" not found` }], isError: true };
          }
          if (!nodeIds.has(ae.target)) {
            return { content: [{ type: "text", text: `Invalid edge: target "${ae.target}" not found` }], isError: true };
          }
          if (ae.source === ae.target) {
            return { content: [{ type: "text", text: `Invalid edge: self-loop on "${ae.source}"` }], isError: true };
          }
          const exists = edges.some((e) => e.source === ae.source && e.target === ae.target);
          if (!exists) {
            edges.push({
              id: `e_${ae.source}_${ae.target}`,
              source: ae.source,
              target: ae.target,
              ...(ae.sourceHandle ? { sourceHandle: ae.sourceHandle } : {}),
              ...(ae.label ? { label: ae.label } : {}),
            });
          }
        }
      }

      await ocApi(`/workflows/${workflowId}`, "PUT", { nodes, edges });

      return { content: [{ type: "text", text: JSON.stringify({ workflowId, nodeId, status: "updated" }) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Failed: ${message}` }], isError: true };
    }
  }
);

server.tool(
  "create_workflow",
  "Create a new workflow with nodes and edges",
  {
    name: z.string().describe("Workflow name"),
    description: z.string().optional().describe("Workflow description"),
    toolName: z.string().optional().describe("Tool name for MCP exposure"),
    nodes: z.array(z.object({
      id: z.string(),
      type: z.enum(NODE_TYPES),
      position: z.object({ x: z.number(), y: z.number() }),
      data: z.object({
        label: z.string(),
        type: z.enum(NODE_TYPES),
        config: z.record(z.unknown()),
      }),
    })).describe("Workflow nodes"),
    edges: z.array(z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      sourceHandle: z.string().optional(),
      label: z.string().optional(),
    })).describe("Workflow edges connecting nodes"),
  },
  async ({ name, description, toolName, nodes, edges }) => {
    const data = await ocApi("/workflows", "POST", { name, description, toolName, nodes, edges }) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify({ id: data.id, name, status: "created" }) }] };
  }
);

server.tool(
  "update_workflow",
  "Update a workflow's metadata (name, toolName, description)",
  {
    workflowId: z.string().describe("The workflow ID to update"),
    name: z.string().optional(),
    toolName: z.string().optional(),
    description: z.string().optional(),
  },
  async ({ workflowId, name, toolName, description }) => {
    try {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (toolName !== undefined) body.toolName = toolName;
      if (description !== undefined) body.description = description;
      await ocApi(`/workflows/${workflowId}`, "PUT", body);
      return { content: [{ type: "text", text: JSON.stringify({ workflowId, status: "updated" }) }] };
    } catch {
      return { content: [{ type: "text", text: "Workflow not found" }], isError: true };
    }
  }
);

server.tool(
  "delete_workflow",
  "Delete a workflow by ID",
  { workflowId: z.string().describe("The workflow ID to delete") },
  async ({ workflowId }) => {
    await ocApi(`/workflows/${workflowId}`, "DELETE");
    return { content: [{ type: "text", text: JSON.stringify({ id: workflowId, status: "deleted" }) }] };
  }
);

// ── Runs ───────────────────────────────────────────────────

server.tool(
  "list_runs",
  "List workflow runs",
  {
    status: z.enum(["queued", "running", "success", "failure", "cancelled"]).optional(),
    limit: z.number().int().positive().max(100).default(20),
  },
  async ({ status, limit }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    const data = await ocApi(`/runs${query ? `?${query}` : ""}`) as { runs: unknown[] };
    const runs = data.runs.slice(0, limit).map((r: Record<string, unknown>) => ({
      id: r.id,
      status: r.status,
      workflowId: r.workflowId,
      createdAt: r.createdAt,
    }));
    return { content: [{ type: "text", text: JSON.stringify(runs) }] };
  }
);

server.tool(
  "get_run",
  "Get details of a specific run including its agent tasks",
  { runId: z.string().describe("The run ID") },
  async ({ runId }) => {
    try {
      const data = await ocApi(`/runs/${runId}`) as { run: unknown; tasks: unknown[] };
      const tasks = (data.tasks as Record<string, unknown>[]).map((t) => ({
        id: t.id,
        nodeId: t.nodeId,
        status: t.status,
        model: t.model,
        prompt: typeof t.prompt === "string" ? t.prompt.slice(0, 100) : t.prompt,
        output: typeof t.output === "string" ? t.output.slice(0, 300) : t.output,
        costUsd: t.costUsd,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ run: data.run, tasks }) }] };
    } catch {
      return { content: [{ type: "text", text: "Run not found" }], isError: true };
    }
  }
);

server.tool(
  "cancel_run",
  "Cancel a running workflow",
  { runId: z.string().describe("The run ID to cancel") },
  async ({ runId }) => {
    await ocApi(`/runs/${runId}/cancel`, "POST");
    return { content: [{ type: "text", text: JSON.stringify({ runId, status: "cancelled" }) }] };
  }
);

// ── Dashboard & Status ──────────────────────────────────────

server.tool(
  "get_dashboard",
  "Get an overview of OpenConclave: workflow count, active runs, recent activity",
  {},
  async () => {
    const data = await ocApi("/dashboard") as Record<string, unknown>;
    const summary = {
      totalWorkflows: data.totalWorkflows,
      totalRuns: data.totalRuns,
      activeRuns: data.activeRuns,
      successCount: data.successCount,
      failureCount: data.failureCount,
      totalCost: data.totalCost,
    };
    return { content: [{ type: "text", text: JSON.stringify(summary) }] };
  }
);

server.tool(
  "get_agent_status",
  "Get the current status of all running and queued agent tasks",
  {},
  async () => {
    const data = await ocApi("/agents/status");
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

// ── Scheduler / Cron ───────────────────────────────────────

server.tool(
  "get_schedule",
  "List all scheduled cron workflows with their next run time",
  {},
  async () => {
    try {
      const data = await ocApi("/scheduler");
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch {
      return { content: [{ type: "text", text: "Scheduler not available" }], isError: true };
    }
  }
);

server.tool(
  "pause_workflow",
  "Pause a workflow — disables it and stops its cron schedule",
  { workflowId: z.string().describe("The workflow ID to pause") },
  async ({ workflowId }) => {
    try {
      await ocApi(`/workflows/${workflowId}`, "PUT", { enabled: false });
      await ocApi("/scheduler/sync", "POST");
      return { content: [{ type: "text", text: JSON.stringify({ id: workflowId, status: "paused" }) }] };
    } catch {
      return { content: [{ type: "text", text: "Workflow not found" }], isError: true };
    }
  }
);

server.tool(
  "resume_workflow",
  "Resume a paused workflow — enables it and restarts its cron schedule",
  { workflowId: z.string().describe("The workflow ID to resume") },
  async ({ workflowId }) => {
    try {
      await ocApi(`/workflows/${workflowId}`, "PUT", { enabled: true });
      await ocApi("/scheduler/sync", "POST");
      return { content: [{ type: "text", text: JSON.stringify({ workflowId, status: "resumed" }) }] };
    } catch {
      return { content: [{ type: "text", text: "Workflow not found" }], isError: true };
    }
  }
);

// ── Start ──────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
