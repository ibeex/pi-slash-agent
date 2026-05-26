# Subagent Prompt Templates Example

This folder contains example prompt templates for `pi-slash-agent`.

These templates expand into instructions that tell Pi to run the explicit `/subagent` slash command in multi-step workflows.

## Included templates

- `implement.md` → `/implement`
- `scout-and-plan.md` → `/scout-and-plan`
- `implement-and-review.md` → `/implement-and-review`

## What they do

- `/implement <task>`: scout → planner → worker
- `/scout-and-plan <task>`: scout → planner
- `/implement-and-review <task>`: worker → reviewer → worker

## Availability

When this package is installed, `package.json` exposes `examples/extensions/subagent/prompts/` as Pi prompt templates.

If Pi is already running, use:

```text
/reload
```

Then type `/` in the editor to see the templates in slash-command completion.

## Notes

- These are **prompt templates**, not extension commands.
- They do **not** make subagents LLM-callable tools.
- They rely on this package's explicit `/subagent` workflow.
