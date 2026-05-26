# Subagent Prompt Templates Example

This folder contains legacy prompt-template examples for `pi-slash-agent`.

The package now implements workflow slash commands like `/scout-and-plan` and `/implement` directly in the extension, so these files are no longer auto-registered by `package.json`.

## Included templates

- `implement.md` → `/implement`
- `scout-and-plan.md` → `/scout-and-plan`
- `implement-and-review.md` → `/implement-and-review`

## What they do

- `/implement <task>`: scout → planner → worker
- `/scout-and-plan <task>`: scout → planner
- `/implement-and-review <task>`: worker → reviewer → worker

## Availability

These examples are kept as reference only. They are not auto-loaded by the package.
If you want to experiment with them manually, wire the directory into Pi prompt-template discovery yourself.

## Notes

- These files are now primarily **reference examples** for the built-in slash workflows.
- They do **not** make subagents LLM-callable tools.
- The supported built-in workflow commands are implemented in `src/index.ts`.
- If you want to run the workflows, invoke the real slash commands directly rather than relying on the old chain-tool wording.
