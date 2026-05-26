# pi-slash-agent

`pi-slash-agent` is a Pi extension that adds explicit slash commands for isolated subagents and ships workflow prompt templates:

- `/subagent <agent> <task>`
- `/subagents`
- `/implement`
- `/scout-and-plan`
- `/implement-and-review`

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

Built-in agents are loaded from this package's markdown definitions in `src/agents/*.md`:

- `scout` - fast codebase reconnaissance
- `planner` - implementation planning from context and requirements
- `reviewer` - code quality and security review
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

### Prompt templates

This package also includes prompt templates in `examples/extensions/subagent/prompts/`.
They expand into `subagent` chains and become available as slash commands after you install or enable the package and run `/reload`.
See `examples/extensions/subagent/README.md` for a focused example overview.

- `/implement` - scout → planner → worker
- `/scout-and-plan` - scout → planner
- `/implement-and-review` - worker → reviewer → worker

## Agent format

User and project-local agents are markdown files with frontmatter:

```md
---
name: api-reviewer
description: Review API changes for compatibility and tests
tools: read, grep, find, ls, bash
---

You are an API review subagent. Do not edit files. Check compatibility,
test coverage, and migration risks. Report PASS/FAIL/PARTIAL with evidence.
```

## Runtime behavior

- Default timeout: `PI_SLASH_AGENT_TIMEOUT_MS` or 10 minutes.
- Runs `pi --mode json -p --no-session` in a subprocess.
- Uses the current Pi working directory as the subprocess cwd.
- Uses the current session model for subagent subprocesses; agent markdown `model` frontmatter is ignored.
- While a subagent is running in interactive mode, the extension shows a live widget near the editor with elapsed time, pid, project-agent notice, recent activity/tool calls, stderr preview, and a warning that newly submitted prompts will queue until the subagent finishes.
- Subprocess handling includes JSON-line buffering, spawn-error capture, stderr capping, timeout termination with process-group SIGTERM/SIGKILL on Unix, and temporary prompt directory cleanup.
- Streams no LLM tool metadata into the main agent because this package exposes only slash commands.

## Package layout

```text
pi-slash-agent/
├── src/
│   ├── agents.ts
│   ├── agents/
│   │   ├── scout.md
│   │   ├── planner.md
│   │   ├── reviewer.md
│   │   ├── worker.md
│   │   ├── general.md
│   │   └── general-purpose.md
│   └── index.ts
├── examples/
│   └── extensions/
│       └── subagent/
│           └── prompts/
│               ├── implement.md
│               ├── scout-and-plan.md
│               └── implement-and-review.md
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```
