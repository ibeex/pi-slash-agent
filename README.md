# pi-slash-agent

`pi-slash-agent` is a Pi extension that adds explicit slash commands for isolated subagents and workflow handoffs:

- `/subagent-run <agent> [--no-handoff] <task>`
- `/subagent-list`
- `/subagent-plan <task>`
- `/subagent-implement <task>`
- `/subagent-review-loop <task>`
- `/subagent-buffer [clear]`

Unlike tool-based subagent packages, this package does **not** register an LLM tool. That means:

- nothing is added to Pi's tool list,
- nothing is added to the default system prompt,
- the main agent cannot call subagents on its own,
- subagents run only when you explicitly invoke the slash command.

## Mental model

If you are used to tool-based subagents, the main difference is:

### Tool-based style

```text
main agent
  └─ calls subagent tool
      └─ child agent runs
```

### `pi-slash-agent` style

```text
you run /subagent-run or a workflow slash command
  └─ extension starts isolated pi subprocess
      └─ child agent runs
          └─ final output can be saved as handoff
```

So instead of the main model deciding when to call a subagent, **you** decide explicitly with slash commands.

## Install

Local repo:

```bash
pi -e .
```

Or install as a Pi package:

```bash
pi install /path/to/pi-slash-agent
```

## How handoffs work

A successful subagent run can save its final output into one session-local handoff buffer.
A later compatible subagent can consume that buffer automatically.

```text
/subagent-run scout Find auth files
        │
        └─ saves handoff = scout output

/subagent-run planner Create a plan
        │
        └─ consumes scout handoff
           saves handoff = planner output

/subagent-run worker Implement it
        │
        └─ consumes planner handoff
           saves handoff = worker output
```

Think of the saved handoff as a single "latest useful result" buffer.
Each successful subagent run replaces the previous saved handoff.

You can inspect or clear it with:

```text
/subagent-buffer
/subagent-buffer clear
```

## Quick start

### One-off subagent

```text
/subagent-run scout Find auth-related files
```

### Manual step-by-step workflow

```text
/subagent-run scout Find auth-related files
/subagent-run planner Create an implementation plan for OAuth support
/subagent-run worker Implement the plan
```

In that sequence:
- `planner` consumes the saved `scout` output
- `worker` consumes the saved `planner` output

### One-command workflow

```text
/subagent-implement Add OAuth support to auth flow
```

That runs:

```text
scout → planner → worker
```

for you automatically.

## Commands

### `/subagent-list`

Lists available agents.

Built-in agents are loaded from this package's markdown definitions in `src/agents/*.md`:

- `scout` - fast codebase reconnaissance
- `planner` - implementation planning from context and requirements
- `reviewer` - code quality and security review
- `worker` - general implementation
- `general` - alias for `worker`

Also loads custom agents from:

```text
.pi/agents/*.md              # project-local, nearest parent of the current cwd
~/.pi/agent/agents/*.md      # user-wide
```

When names collide, project-local agents override user agents, and user agents override built-ins. Project-local agents are explicit slash-command only; this extension still does not expose an LLM-callable subagent tool.

Handoff auto-consume behavior is special-cased only for the built-in workflow agents (`planner`, `worker`, `reviewer`) plus the built-in alias `general`. If you override `general` with your own custom agent, it behaves like your custom agent rather than inheriting built-in `worker` handoff semantics.

### `/subagent-run <agent> [--no-handoff] <task>`

Runs one isolated Pi subprocess for the requested agent.

Successful subagent runs save their final output into a session-local handoff buffer.
When a later built-in subagent supports consuming that saved handoff, the extension automatically injects it unless you pass `--no-handoff`.

This gives you a slash-command version of multi-step delegation without reintroducing a hidden LLM tool.

Examples:

```text
/subagent-run scout Find auth-related files. Do not edit files.
/subagent-run planner Create an implementation plan for OAuth support.
/subagent-run worker Implement the requested change using the saved plan.
/subagent-run reviewer Review the recent changes for correctness and risk.
/subagent-run worker Apply the saved review feedback.
/subagent-run planner --no-handoff Create a plan from scratch.
```

### `/subagent-buffer [clear]`

Shows the current saved handoff buffer, including which agent produced it and a preview of the saved output.

Built-in auto-consume rules currently are:

| Consumer | Accepts saved handoff from |
|---|---|
| `planner` | `scout` |
| `worker` | `scout`, `planner`, `reviewer` |
| `reviewer` | `worker` |

Built-in alias `general` behaves like `worker`.

Use `/subagent-buffer clear` to clear it.

### Workflow commands

The package includes built-in workflow slash commands implemented in the extension itself:

- `/subagent-plan <task>` - scout → planner with automatic handoff
- `/subagent-implement <task>` - scout → planner → worker with automatic handoff
- `/subagent-review-loop <task>` - worker → reviewer → worker with automatic handoff

Diagram:

```text
/subagent-plan
  scout ──handoff──▶ planner

/subagent-implement
  scout ──handoff──▶ planner ──handoff──▶ worker

/subagent-review-loop
  worker ──handoff──▶ reviewer ──handoff──▶ worker
```

Each step still runs in its own isolated Pi subprocess. The extension captures one step's final output and injects it into the next step's task, so no manual copy/paste is needed.

## Agent format

User and project-local agents are markdown files with frontmatter. `tools` can be a comma-separated string or a YAML list:

```md
---
name: api-reviewer
description: Review API changes for compatibility and tests
tools: read, grep, find, ls, bash
---

You are an API review subagent. Do not edit files. Check compatibility,
test coverage, and migration risks. Report PASS/FAIL/PARTIAL with evidence.
```

## Why this exists

This package is meant for users who want the benefits of subagents without tool-based orchestration:

- explicit control over when subagents run
- isolated subprocesses with narrow prompts
- reproducible handoffs between steps
- no extra LLM tool exposed to the main agent

If you prefer the model to decide on its own when to delegate, a tool-based subagent package is a better fit.
If you prefer explicit slash-command control, this package is designed for that workflow.

## Runtime behavior

- Default timeout: `PI_SLASH_AGENT_TIMEOUT_MS` or 10 minutes.
- Runs `pi --mode json -p --no-session` in a subprocess.
- Uses the current Pi working directory as the subprocess cwd.
- Uses the current session model for subagent subprocesses; agent markdown `model` frontmatter is ignored.
- While a subagent is running in interactive mode, the extension shows a live widget near the editor with elapsed time, pid, project-agent notice, recent activity/tool calls, stderr preview, and a warning that newly submitted prompts will queue until the subagent finishes.
- Subprocess handling includes JSON-line buffering, spawn-error capture, stderr capping, timeout termination with process-group SIGTERM/SIGKILL on Unix, and temporary prompt directory cleanup.
- Streams no LLM tool metadata into the main agent because this package exposes only slash commands.
- Workflow handoffs are performed by the extension code, not by an LLM-callable tool.
- The saved handoff buffer is session-local and lives only inside the running extension process.
- Successful subagent runs update the single saved handoff buffer; later compatible built-in agents can consume it automatically.

## Package layout

Legacy reference examples:
- `examples/extensions/subagent/prompts/*` are reference-only and are not auto-loaded by this package.


```text
pi-slash-agent/
├── src/
│   ├── agents.ts
│   ├── agents/
│   │   ├── scout.md
│   │   ├── planner.md
│   │   ├── reviewer.md
│   │   ├── worker.md
│   │   └── general.md
│   └── index.ts
├── examples/
│   └── extensions/
│       └── subagent/
│           └── prompts/            # legacy reference examples; not auto-loaded
│               ├── subagent-implement.md
│               ├── subagent-plan.md
│               └── subagent-review-loop.md
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```
