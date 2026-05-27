# Subagent Prompt Templates Example

This folder contains legacy prompt-template examples for `pi-slash-agent`.

The package now implements workflow slash commands like `/subagent-plan` and `/subagent-implement` directly in the extension, so these files are no longer auto-registered by `package.json`.

## Included templates

- `subagent-implement.md` → `/subagent-implement`
- `subagent-plan.md` → `/subagent-plan`
- `subagent-review-loop.md` → `/subagent-review-loop`

## What they do

- `/subagent-implement <task>`: scout → planner → worker
- `/subagent-plan <task>`: scout → planner
- `/subagent-review-loop <task>`: worker → reviewer → worker

## Availability

These examples are kept as reference only. They are not auto-loaded by the package.
If you want to experiment with them manually, wire the directory into Pi prompt-template discovery yourself.

## Notes

- These files are now primarily **reference examples** for the built-in slash workflows.
- They do **not** make subagents LLM-callable tools.
- The supported built-in workflow commands are implemented in `src/index.ts`.
- If you want to run the workflows, invoke the real slash commands directly rather than relying on the old chain-tool wording.
