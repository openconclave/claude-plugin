#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const OC_URL = process.env.OPENCONCLAVE_URL ?? 'http://localhost:4000'
const OC_WS_URL = process.env.OPENCONCLAVE_WS_URL ?? 'ws://localhost:4000'

async function ocApi(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${OC_URL}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return res.json()
}

const mcp = new Server(
  { name: 'openconclave-channel', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'Events from OpenConclave arrive as <channel source="openconclave-channel" event_type="..." ...>.',
      '',
      'Event types:',
      '- channel:output — a workflow produced output for you. Read and present to user.',
      '- prompt:question — a workflow is asking YOU a question and waiting for your response.',
      '',
      'Tools:',
      '- oc_list_workflows: see all workflows',
      '- oc_trigger_workflow: start a workflow run with optional payload',
      '- oc_get_run: get run details',
      '- oc_list_runs: list recent runs',
      '- oc_respond: respond to a pending prompt question (REQUIRED when prompt:question events arrive)',
      '- oc_pending_prompts: list all prompts waiting for response',
      '',
      'IMPORTANT: When you receive a prompt:question event, respond immediately using oc_respond. The workflow is blocked until you do.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'oc_list_workflows',
      description: 'List all workflows in OpenConclave',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'oc_trigger_workflow',
      description: 'Trigger a workflow run. Always pass your current working directory as cwd so agents run in the correct project.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'The workflow ID to trigger' },
          payload: { type: 'object', description: 'Optional payload data', additionalProperties: true },
          cwd: { type: 'string', description: 'Your current working directory' },
        },
        required: ['workflow_id', 'cwd'],
      },
    },
    {
      name: 'oc_get_run',
      description: 'Get details of a specific workflow run including tasks and events',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'string', description: 'The run ID' } },
        required: ['run_id'],
      },
    },
    {
      name: 'oc_list_runs',
      description: 'List recent workflow runs',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max results (default 10)' } },
      },
    },
    {
      name: 'oc_respond',
      description: 'Respond to a pending prompt question from a workflow. Use when you receive prompt:question events.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'The run ID' },
          node_id: { type: 'string', description: 'The prompt node ID' },
          response: { type: 'string', description: 'Your response' },
        },
        required: ['run_id', 'node_id', 'response'],
      },
    },
    {
      name: 'oc_pending_prompts',
      description: 'List all pending prompt questions waiting for responses',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  switch (name) {
    case 'oc_list_workflows': {
      const data = await ocApi('/workflows')
      const summary = (data.workflows ?? []).map((w: Record<string, unknown>) => ({
        id: w.id, name: w.name, enabled: w.enabled,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
    }

    case 'oc_trigger_workflow': {
      const { workflow_id, payload, cwd } = args as { workflow_id: string; payload?: Record<string, unknown>; cwd?: string }
      const enrichedPayload = { ...(payload ?? {}), ...(cwd ? { _callerCwd: cwd } : {}) }
      const data = await ocApi(`/workflows/${workflow_id}/run`, 'POST', { payload: enrichedPayload })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    case 'oc_get_run': {
      const { run_id } = args as { run_id: string }
      const data = await ocApi(`/runs/${run_id}`)
      const tasks = (data.tasks ?? []).map((t: Record<string, unknown>) => ({
        id: t.id, nodeId: t.nodeId, status: t.status, model: t.model,
        prompt: (t.prompt as string)?.slice(0, 100),
        output: (t.output as string)?.slice(0, 300),
        costUsd: t.costUsd,
      }))
      return { content: [{ type: 'text', text: JSON.stringify({ run: data.run, tasks }, null, 2) }] }
    }

    case 'oc_list_runs': {
      const { limit } = (args ?? {}) as { limit?: number }
      const data = await ocApi(`/runs?limit=${limit ?? 10}`)
      const summary = (data.runs ?? []).map((r: Record<string, unknown>) => ({
        id: r.id, status: r.status, workflowId: r.workflowId, createdAt: r.createdAt,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
    }

    case 'oc_respond': {
      const { run_id, node_id, response } = args as { run_id: string; node_id: string; response: string }
      const data = await ocApi('/prompts/respond', 'POST', { runId: run_id, nodeId: node_id, response })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    case 'oc_pending_prompts': {
      const data = await ocApi('/prompts/pending')
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    default:
      throw new Error(`unknown tool: ${name}`)
  }
})

await mcp.connect(new StdioServerTransport())
process.stderr.write('[oc-channel-dev] MCP connected\n')

// ── WebSocket bridge to OpenConclave ────────────────────────

function connectWebSocket() {
  try {
    process.stderr.write(`[oc-channel-dev] Connecting to ${OC_WS_URL}...\n`)
    const ws = new WebSocket(OC_WS_URL)

    ws.onopen = () => {
      process.stderr.write('[oc-channel-dev] WebSocket connected\n')
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['dashboard'] }))
    }

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data.toString())
        const eventType = data.type as string

        if (eventType === 'channel:output' || eventType === 'prompt:question') {
          const meta: Record<string, string> = {
            event_type: eventType,
            run_id: String(data.runId ?? ''),
          }
          if (data.nodeId) meta.node_id = data.nodeId
          if (data.data?.workflowName) meta.workflow_name = data.data.workflowName
          if (data.data?.nodeLabel) meta.node_label = data.data.nodeLabel

          const content = typeof data.data === 'string'
            ? data.data
            : JSON.stringify(data.data ?? {}, null, 2)

          process.stderr.write(`[oc-channel-dev] Forwarding ${eventType} run=${data.runId}\n`)

          await mcp.notification({
            method: 'notifications/claude/channel',
            params: { content, meta },
          })
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = () => {
      process.stderr.write('[oc-channel-dev] WebSocket closed, reconnecting in 5s...\n')
      setTimeout(connectWebSocket, 5000)
    }

    ws.onerror = () => {
      // triggers onclose
    }
  } catch {
    setTimeout(connectWebSocket, 5000)
  }
}

connectWebSocket()
