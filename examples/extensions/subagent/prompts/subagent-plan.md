---
description: Reference for the built-in /subagent-plan workflow
---
This workflow is now implemented directly by the extension as a slash command.

Preferred usage:

```text
/subagent-plan $@
```

Behavior:
1. Run `scout` on the request: $@
2. Capture the scout's final output as an explicit handoff
3. Run `planner` with:
   - the original request
   - the scout handoff
4. Return the plan only; do not implement
