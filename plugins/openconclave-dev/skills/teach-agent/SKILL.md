---
description: "Supervised learning loop for OpenConclave conclaves. Use to either (1) record a known mistake an agent made into the knowledge book and rewire the agent's system prompt to prevent repeat, OR (2) audit a completed conclave run end-to-end — read every agent's thinking and outputs, identify prompt-adherence failures and wasted effort even in successful runs, then capture the findings as lessons and prompt updates. Triggers on: 'teach this agent', 'add this to the knowledge book', 'oc supervised learning', 'remember this mistake', 'don't let the agent do this again', 'audit the run', 'check what the agents did', 'review run <N>', 'what did the agents actually do', 'look at their thinking', 'any issues with the last run'."
argument-hint: "Describe the mistake OR name the run to audit"
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - mcp__plugin_openconclave-dev_openconclave-dev__list_conclaves
  - mcp__plugin_openconclave-dev_openconclave-dev__get_conclave
  - mcp__plugin_openconclave-dev_openconclave-dev__update_conclave
---

# Teach an OpenConclave Agent (Supervised Learning)

You are closing the loop on an OpenConclave supervised-learning incident. An agent in a conclave produced sub-optimal work, the user wants it captured so future runs do not repeat the mistake.

Your outputs always ship in the same pair:

1. A knowledge-base document that records the lesson in a way future agents can retrieve.
2. An update to the offending agent's system prompt that forces consultation of the knowledge base before the kind of work where the mistake occurred, and restructures the prompt if the original structure let the agent ignore the rule.

Never do one without the other. A lesson nobody reads is dead text. An instruction to "check the book" with nothing in the book is busywork. A rule added at the bottom of a prompt where the detailed instructions above overrode it is a placebo.

## Two intake paths

This skill runs in one of two modes:

**Mode A — Known mistake.** The user hands you a concrete failure: "the test writer inlined copies of production functions instead of importing them." Skip to `Inputs you need` and work from there.

**Mode B — Audit.** The user says "check run 409" or "what did the agents actually do" or "any issues with that pipeline run." The conclave may even appear to have succeeded. Start with `Discovery — audit the run first`, then proceed through the rest of the skill with the issues you surfaced.

Mode B is the more valuable path and the one most engineers forget exists. A conclave that finishes green is not the same as a conclave whose agents did their job well. The audit mode is how the OpenConclave supervised learning loop actually closes — someone reads what the agents were thinking, catches the drift, and tightens the prompts before the drift becomes a real incident.

## Discovery — audit the run first

When you are in Mode B, do not write a lesson until you have actually read the run. Here is the procedure.

### Step 1: Fetch the run

```bash
curl -s http://localhost:4000/api/runs/<runId> > /tmp/run.json
```

Every run has three layers of evidence:

- **`tasks[]`** — one per executed agent node. Each has `startedAt`, `completedAt`, `status`, and a final `output` field. The output is what the agent *handed to the next node*.
- **`events[]`** — the full chronological event stream. Agents emit `agent:thinking` events with their reasoning blocks, `agent:output` events with streamed chunks, and `agent:started`/`agent:completed` lifecycle events.
- **`events[].data.thinking`** on `agent:thinking` events — an array of `{thinking: string, signature: string}` objects. Each entry is a reasoning block the model produced. These are GOLD. They show what the agent was actually considering, before its final answer smoothed everything over.

### Step 2: Extract thinking blocks per task

A bun one-liner to print every thinking block grouped by task, without drowning in the full event stream:

```bash
bun -e '
const d = JSON.parse(await Bun.file("/tmp/run.json").text());
const byTask = {};
for (const e of d.events || []) {
  if (e.type === "agent:thinking" && e.data?.thinking) {
    const tid = e.data.taskId;
    if (!byTask[tid]) byTask[tid] = [];
    for (const b of e.data.thinking) byTask[tid].push(b.thinking || "");
  }
}
for (const t of d.tasks || []) {
  const blocks = byTask[t.id] || [];
  console.log(`\n========== ${t.nodeId} task ${t.id} — ${blocks.length} thinking blocks ==========`);
  for (let i = 0; i < blocks.length; i++) {
    console.log(`--- block ${i+1} ---`);
    console.log(blocks[i].slice(0, 2000));
    if (blocks[i].length > 2000) console.log(`... [+${blocks[i].length - 2000} more chars]`);
  }
}
'
```

Also read each task's final `output` separately — it is sometimes very different from what the thinking suggests the agent would produce:

```bash
bun -e '
const d = JSON.parse(await Bun.file("/tmp/run.json").text());
for (const t of d.tasks || []) {
  console.log(`\n========== ${t.nodeId} final output ==========`);
  console.log((t.output || "").slice(0, 3000));
}
'
```

### Step 3: Read the agents' system prompts

Get the conclave definition that was used for this run and pull each agent's system prompt. You need the system prompts to compare what the agent *should* have done against what it *actually* did.

```bash
curl -s http://localhost:4000/api/conclaves/<conclaveId> > /tmp/wf.json
bun -e '
const wf = JSON.parse(await Bun.file("/tmp/wf.json").text());
const def = wf.definition || wf;
for (const n of def.nodes || []) {
  if (n.type === "agent") {
    console.log("\n========== " + n.data.label + " ==========");
    console.log(n.data.config.systemPrompt || "(no system prompt)");
  }
}
'
```

### Step 4: Diagnose — what to look for

Walk through each agent and look for these patterns. Each one maps to a specific fix class.

**Pattern 1: Agent recognized a rule in its thinking and then ignored it.**

Signature: a thinking block says something like "Actually, looking at this more carefully, the task is straightforward — I should skip X." Then the next block does X anyway.

This is the most informative finding. The rule IS in the prompt, the agent understood it, and still ignored it. Root cause is almost always **prompt structure**: the rule was buried under detailed instructions that the model defaulted to. Fix: move the rule to the top of the prompt with an explicit marker (`FIRST ACTION:`, `CRITICAL:`, `MANDATORY:`). Do not just rephrase the rule — restructure the prompt so the rule is unavoidable.

**Pattern 2: Agent used the wrong command or API when a right one exists.**

Signature: thinking blocks show the agent running `git log`, `git diff HEAD~1`, `find` with `-exec`, a shell pattern the project forbids, or any other command that doesn't match the conclave's actual state. Often the agent recovers on a thinking block or two but wastes effort.

Fix: name the wrong commands in the prompt explicitly as FORBIDDEN, and list the right commands as REQUIRED. Do not just say "use git correctly" — say "do NOT use `git diff HEAD~1`, DO use `git diff` and `git status --porcelain`."

**Pattern 3: Agent wasted thinking blocks on context it should already have.**

Signature: thinking blocks like "Let me check what directory I'm in", "Let me find the package.json", "Let me figure out which branch I'm on". These are preamble questions the conclave already answered.

Fix: add a short preamble to the prompt that states the context directly. Example: "Your cwd is already set to the task worktree. Use relative paths. Do not `pwd` or `cd`." Preamble should be above the role description so it's read first.

**Pattern 4: Agent did too much work.**

Signature: an agent with a tight, specific role produces far more thinking blocks than its siblings. Often re-runs tests that were already verified by an upstream agent, re-searches knowledge, or fetches sources the task did not need.

Fix: forbid the specific redundant action by name. Do not rely on "be efficient" — say "DO NOT run `bun test` or `vitest run`; the Test Runner already verified."

**Pattern 5: Agent did too little work.**

Signature: an agent that was supposed to consult the knowledge base, read files, or ask clarifying questions skipped those steps entirely. Look for empty tool-call streams or thinking blocks that jump straight to output.

Fix: move the required action to the top of the prompt as a MANDATORY block with an exact query list or file list. Make it unavoidable.

**Pattern 6: Agent ignored the channel loop when it should have asked.**

Signature: thinking blocks show the agent making a judgment call that was genuinely ambiguous, with no clarification request. Or the opposite — the agent asked something trivial that it could have decided for itself.

Fix: refine the "when to ask" section of the prompt with explicit examples of when to ask and when not to.

**Pattern 7: Environment or tooling issue the agent had to work around.**

Signature: thinking blocks mention dependency errors, missing binaries, wrong paths, or any infrastructure problem the agent had to solve before doing its real job.

Fix: usually NOT a prompt issue. Usually a conclave issue (Setup node should handle the prep) or a project issue (install step missing). Note it for later investigation; do not force a prompt-level fix.

### Step 5: Prioritize findings

Not every finding deserves a lesson. Rank each one:

- **High**: would cause wrong output on a harder task (e.g. Reviewer using `git log` when changes are uncommitted — recovered by luck on a small task, would fail silently on a big one).
- **Medium**: measurable wasted work every run (e.g. Summarizer re-running tests adds 40s to every pipeline run).
- **Low**: noise, one-off, or not reproducible without the specific environment condition.

Act on High and Medium. Note Low findings for the user and move on.

### Step 6: Report before acting

Before writing lessons or patching prompts, report your findings to the user as a structured list: finding, agent, impact, proposed fix. The user may tell you a finding you want to fix is actually intentional, or that a finding you didn't prioritize is actually critical. Do not skip this step — audit findings can misread intent.

After the user confirms, proceed through the rest of the skill for each finding you are acting on.

## Inputs you need

Whether you arrived here via Mode A or Mode B, before writing anything establish:

- **What the mistake was.** Concrete facts from the thinking stream (Mode B) or from the user's description (Mode A).
- **Which agent produced it.** Conclave id + node id + agent label.
- **Which knowledge base the agent reads from.** Inspect the agent's node config — look at `config.tools` for a `toolType: "knowledge"` entry. If there isn't one, the agent has no KB attached and you will need to attach one before teaching works. Surface this to the user before proceeding.
- **When the lesson should apply.** Be specific about the trigger. "Before writing any test" is a good trigger. "When reviewing code" is too broad.

## Writing the knowledge document

A good lesson is neither a one-liner platitude nor a tome. Aim for roughly one screen of markdown with this structure:

```markdown
---
tags: <comma-separated tags — mix general terms AND the specific symbols involved>
when-to-consult: <one sentence explaining the exact trigger>
---

# <Short, declarative title — the rule itself, not the domain>

Keywords for retrieval: <another pass of retrieval vocabulary including every specific function name, file name, and type name from the incident>

## The anti-pattern
<What the mistake looks like in practice. Use concrete language.>

## Warning signs
<Bullet list of how to spot it in the output>

## What to do instead
<The correct approach, numbered. Include the *easy* correct path AND the escape hatch if the easy path is blocked.>

## Why it matters
<Two or three sentences on the concrete damage the anti-pattern causes.>

## Known incident
<Date, conclave/run id, files touched, what was produced, what should have been produced. Be specific — this is what makes bug-specific queries pull the lesson.>
```

**Tag discipline:** the single biggest failure mode of lessons in this KB is poor retrieval. An agent facing a new bug will search with the vocabulary of that bug, not the vocabulary of the lesson. Your tags must cover:

- Generic topical terms ("testing", "code-review", "error-handling", "type-safety")
- Generic anti-pattern terms ("inline-copy", "swallow-error", "magic-string")
- The specific symbols from the known incident (function names, file names, type names)
- The artifact type ("red-test", "regression-test", "vitest", "system-prompt", "review")

Also sprinkle those terms naturally into the body — semantic search rewards content matches, not just frontmatter.

Don't write a lesson that only applies to one file in the codebase. Generalize the rule, but ground it with the specific incident. If you can only think of one example, the lesson is probably too narrow; step back and ask what the underlying principle is.

## Ingesting the document

The openconclave-dev MCP does not expose knowledge tools, so use the HTTP API via Bash.

Find the API URL — usually `http://localhost:4000`. Confirm by running `curl -s http://localhost:4000/api/knowledge` and checking that it returns a JSON list of knowledge bases.

To ingest, write the markdown to a temp file and build the JSON payload from it:

```bash
# 1. Write the lesson to a temp markdown file, then build the JSON payload.
#    Use a bun one-liner to build the JSON so you don't have to escape quotes by hand.
cat > /tmp/lesson.md <<'MD'
---
tags: ...
---
# Lesson title
...
MD

bun -e 'const text = await Bun.file("/tmp/lesson.md").text(); await Bun.write("/tmp/lesson.json", JSON.stringify({ filename: "my-lesson.md", text }));'

# 2. POST to the target knowledge base.
curl -s -X POST http://localhost:4000/api/knowledge/<kb-id>/ingest \
  -H "Content-Type: application/json" \
  -d @/tmp/lesson.json
```

The response returns the new `documentId`. Remember it in case you need to replace the document later.

If you are updating an existing lesson rather than adding a new one, delete the old document first so you don't accumulate duplicates:

```bash
curl -s -X DELETE http://localhost:4000/api/knowledge/<kb-id>/documents/<doc-id>
```

## Verifying retrieval before you finish

Do not ship a lesson without confirming it is discoverable. Run at least three searches against the KB and check the lesson appears near the top for each:

1. A generic topical query ("testing lesson", "error handling", "code review")
2. The name of the specific symbol from the incident
3. A query phrased the way a future agent would search ("reviewer git diff", "skip external research")

Use the search endpoint:

```bash
curl -s -X POST http://localhost:4000/api/knowledge/<kb-id>/search \
  -H "Content-Type: application/json" \
  -d '{"query":"<query>","topK":3}'
```

If the lesson does not appear in at least two of the three queries (score above ~0.5, filename matches your lesson), go back and add more keywords to the frontmatter `tags` line and the "Keywords for retrieval" line. Re-ingest and re-verify. Do not skip this step — a lesson with bad retrieval is invisible.

## Updating the agent's system prompt

Fetch the conclave via `get_conclave`, find the target agent node, and produce a new system prompt. This is where most teach-agent runs fail the critical test: **putting a rule in a prompt is not enough. Prompt structure matters as much as prompt content.**

### What to check before you change anything

Go back to the audit findings (or, in Mode A, think about where the rule would sit in the existing prompt). Ask these questions:

- **Was the rule in the prompt already and the agent ignored it?** If yes, the problem is structural, not additive. The rule is buried under detailed instructions that the model defaults to. Adding another "please be efficient" sentence will not help.
- **Where in the prompt is the rule?** Top, middle, or bottom. Rules near the bottom get ignored with alarming reliability.
- **Is the rule specific or abstract?** "Be efficient" is abstract. "Do NOT run `bun test` — the Test Runner already verified" is specific.
- **Does the rule name the forbidden thing?** Agents respect prohibitions more when the prohibited action is named explicitly.
- **Does the rule have visual weight?** CAPS, `CRITICAL:`, `MANDATORY:`, `FIRST ACTION:` markers help. Agents respect emphasis.

### How to restructure

If the rule was buried, move it. The easy edit is not the right edit.

1. **Keep the agent's core role.** Don't rewrite the whole prompt.
2. **Move critical rules to the TOP** — before the role description, before the "your job" section. The first thing the agent reads should be the thing that most matters.
3. **Use visible markers.** `## CRITICAL:` or `## MANDATORY:` or `## FIRST ACTION:` headers with the rule inline. All-caps words inside the block.
4. **Name the forbidden thing specifically.** Instead of "don't waste effort", write "Do NOT run \`bun test\`, \`vitest run\`, or \`npm test\`. The Test Runner already verified." The named commands make the rule unambiguous.
5. **Name the required thing specifically.** Instead of "use git correctly", write "DO use \`git status --porcelain\` and \`git diff\` (no HEAD reference)."
6. **Reference the Dev Book lesson by filename.** "The Dev Book has a lesson called `reviewer-lesson-uncommitted-changes` that explains the full reasoning." This gives the agent a second path to the lesson even if semantic search misses it during its mandatory KB search.
7. **Explain why, briefly.** One sentence on the concrete damage the wrong behavior caused. Agents trained to be helpful will otherwise rationalize around the rule.
8. **Keep a MANDATORY KB search block** if one exists, and add any new required queries to it. Do not duplicate KB search instructions across sections.

### Example — bad vs good

**Bad:** adds a rule at the bottom of an already-long prompt:

```markdown
...
## Your job
1. Run tests
2. Parse output
3. Report the result

## Rules
- Be efficient.
- Don't re-run tests unnecessarily.  ← NEW, buried at the bottom
```

The rule is present but the agent's attention is on the numbered "Your job" steps above. It will re-run tests to verify, thinking it is being thorough.

**Good:** restructures the prompt to put the rule at the top with visible weight:

```markdown
# Your role
You are the Summarizer.

## CRITICAL: do NOT re-run tests

The Test Runner has already verified that tests pass. Its verdict is `VERDICT:TESTS_PASS` and that verdict is authoritative. Your job is NOT to re-verify.

Do NOT run `bun test`, `vitest run`, `npm test`, or any other test command. Re-running tests:
- Wastes compute and time (can add 30+ seconds to the pipeline)
- Risks exposing you to pre-existing failing tests in unrelated packages
- Duplicates work the pipeline already guarantees

If you are tempted to run tests "just to make sure," you are wrong. Trust the verdict from your input.

The Dev Book has a lesson called `summarizer-lesson-do-not-rerun-tests` that explains the reasoning in more detail.

## Your job
1. Run `git status`, `git diff --stat`, and `git log --oneline -5`. These are READ-ONLY inspections. No test commands.
2. Write the report.
...
```

The rule is unavoidable. The agent reads it before the "your job" list. The forbidden commands are named. The reasoning is explicit. The Dev Book is cited by filename.

### After constructing the new prompt

Call `update_conclave` with the FULL updated nodes and edges arrays — the API expects a complete replace. Preserve every other field of the agent's config exactly. If you only need to update one node, build the body by mutating the fetched definition in place.

If you have to update multiple agents in one audit pass, batch them into a single update call. Multiple sequential PUTs risk interleaving with in-flight runs.

## Verifying the rewiring

Do not declare victory until both halves landed and the fix is plausible:

1. Call `get_conclave` again and confirm the agent's `systemPrompt` matches what you sent.
2. Query the KB one more time with the topical query and confirm the lesson still surfaces.
3. Re-read the patched prompt as if you were the agent on its next run. Is the critical rule unavoidable? Would you follow it? If you could still see yourself defaulting to the old behavior, go back and restructure further.
4. Summarize for the user: which KB doc id was created, which agent was updated, what specific queries will pull the lesson up, and what the before/after of the prompt looked like for the critical rule.

If the user wants, they can trigger the conclave again on the same input to watch whether the agent actually consults the book and follows the rule. That is the real test, and on a non-trivial audit you should suggest it — but do not run it yourself unless the user asks.

## Non-goals

- **Do not fix the underlying code** the agent's work touched. That is a separate concern; this skill is only about teaching the agent not to repeat the mistake.
- **Do not update multiple agents** unless the audit explicitly found issues in multiple agents. The lesson may apply to other roles, but the scope is bounded by what you observed.
- **Do not invent a new knowledge base.** Use the one the agent already reads from.
- **Do not generalize the lesson across domains** (e.g., turning "don't inline test helpers" into "always import dependencies"). A lesson that tries to apply everywhere applies nowhere.
- **Do not skip the audit step in Mode B** because the conclave ran green. A green conclave with wasted effort or incorrect shortcuts is still a conclave that deserves tightening.

## Failure modes to watch

- **Duplicate lessons.** Before ingesting a new doc, search the KB for existing lessons on the same topic. If one exists, delete it and re-ingest the merged version rather than adding a parallel doc.
- **Lesson only triggers on its own tags.** Verify retrieval with queries that use the bug's vocabulary, not the lesson's vocabulary. If the lesson only appears when you search for its own title, it will never trigger in production.
- **System prompt grows unboundedly.** Each new lesson should not add a new section to every agent's prompt. Group related instructions. If the prompt is getting long, consider whether the new lesson belongs inline or should be referenced indirectly via the KB search step.
- **Agent doesn't have the KB attached.** Check the agent's `config.tools` for `toolType: "knowledge"`. If missing, telling the agent to "search the Dev Book" does nothing — it has no `search_knowledge` tool. Surface this to the user before continuing.
- **The rule was already in the prompt and the agent ignored it.** This is the most dangerous failure mode because it's tempting to just add the rule again with slightly different wording. Don't. Restructure. The fix is structural, not additive.
- **The audit surfaces a conclave bug disguised as a prompt bug.** Sometimes the right fix is not a lesson but a conclave change — adding an install step to Setup Worktree, rewiring a condition, adjusting node ordering. If the audit finding can be fixed at the conclave level, that is better than a prompt-level workaround. Surface the choice to the user.
- **You forgot to report findings before acting.** In Mode B, always report the audit findings to the user before patching anything. Your interpretation of a thinking block may be wrong. The user knows what the conclave was supposed to do.
