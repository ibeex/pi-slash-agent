# pi-slash-agent

`pi-slash-agent` is a Pi extension that adds explicit slash commands for isolated subagents:

- `/subagent <agent> <task>`
- `/subagents`

Unlike tool-based subagent packages, this package does **not** register an LLM tool. That means:

- nothing is added to Pi's tool list,
- nothing is added to the default system prompt,
- the main agent cannot call subagents on its own,
- subagents run only when you explicitly invoke the slash command.

## Install

Local repo:

```bash
pi -e .
```

Or install as a Pi package:

```bash
pi install /path/to/pi-slash-agent
```

## Commands

### `/subagents`

Lists available agents.

Built-in agents:

- `scout` - read-only reconnaissance
- `planner` - planning
- `reviewer` - read-only review/verification
- `worker` - general implementation
- `general` - alias for `worker`
- `general-purpose` - alias for `worker`

Also loads custom agents from:

```text
.pi/agents/*.md              # project-local, nearest parent of the current cwd
~/.pi/agent/agents/*.md      # user-wide
```

When names collide, project-local agents override user agents, and user agents override built-ins. Project-local agents are explicit slash-command only; this extension still does not expose an LLM-callable subagent tool.

### `/subagent <agent> <task>`

Runs one isolated Pi subprocess for the requested agent.

Examples:

```text
/subagent scout Find auth-related files. Do not edit files.
/subagent reviewer Review the recent changes for correctness and risk.
/subagent worker Implement the fix in src/auth.ts and summarize changed files.
```

## Agent format

User and project-local agents are markdown files with frontmatter:

```md
---
name: api-reviewer
description: Review API changes for compatibility and tests
tools: read, grep, find, ls, bash
model: sonnet
---

You are an API review subagent. Do not edit files. Check compatibility,
test coverage, and migration risks. Report PASS/FAIL/PARTIAL with evidence.
```

## Runtime behavior

- Default timeout: `PI_SLASH_AGENT_TIMEOUT_MS` or 10 minutes.
- Runs `pi --mode json -p --no-session` in a subprocess.
- Uses the current Pi working directory as the subprocess cwd.
- While a subagent is running in interactive mode, the extension shows a live widget near the editor with elapsed time, pid, project-agent notice, recent activity/tool calls, stderr preview, and a warning that newly submitted prompts will queue until the subagent finishes.
- Subprocess handling includes JSON-line buffering, spawn-error capture, stderr capping, timeout termination with process-group SIGTERM/SIGKILL on Unix, and temporary prompt directory cleanup.
- Streams no LLM tool metadata into the main agent because this package exposes only slash commands.

## Package layout

```text
pi-slash-agent/
├── src/
│   ├── agents.ts
│   └── index.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```
