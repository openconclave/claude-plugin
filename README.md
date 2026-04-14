# OpenConclave Plugins for Claude Code

Two Claude Code plugins for [OpenConclave](https://openconclave.com):

- **`openconclave-channel`** — receives channel events from running conclaves (channel loop prompts, conclave output) and lets Claude Code respond inline. Required for the Claude-in-the-loop pattern.
- **`openconclave-dev`** — MCP tools for managing conclaves, runs, agents, and KBs from Claude Code. Required for building/editing conclaves via Claude.

Most users want **both**.

## Install (current path)

> **⚠ Important:** The marketplace install path below is still being finalized. Until then, load the plugins in dev mode every time you start Claude Code:

```bash
claude --dangerously-load-development-channels plugin:openconclave-channel@openconclave
```

```bash
claude --dangerously-load-development-channels plugin:openconclave-dev@openconclave
```

You can also alias these in your shell. Without them, the OpenConclave channel events won't reach your Claude Code session and you can't manage conclaves from Claude.

## Install (eventual path — not fully working yet)

Once marketplace registration lands:

```
/plugin marketplace add openconclave/openconclave-marketplace
/plugin install openconclave-channel
/plugin install openconclave-dev
```

## What you get

### `openconclave-channel`
- **Channel events** — receive `channel:output` and `prompt:question` events from running conclaves, respond inline via `oc_respond`
- **Conclaves as tools** — every enabled conclave with a `toolName` shows up as its own MCP tool callable directly from Claude

### `openconclave-dev`
- **MCP tools** for managing OC: `create_conclave`, `update_conclave`, `update_node`, `list_conclaves`, `get_run`, `trigger_conclave`, etc.
- **Auto-start server** — launches the OC server on Claude Code session start
- **`/create-conclave` skill** — build conclaves from natural-language descriptions

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (latest)
- A running OpenConclave instance — see [openconclave/oc](https://github.com/openconclave/oc) for install

## Links

- [OpenConclave](https://openconclave.com)
- [Main repo](https://github.com/openconclave/oc)
- [Starter conclaves](https://github.com/openconclave/conclaves)
