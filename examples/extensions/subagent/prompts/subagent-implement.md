---
description: Reference for the built-in /subagent-implement workflow
---
This workflow is now implemented directly by the extension as a slash command.

Preferred usage:

```text
/subagent-implement $@
```

Behavior:
1. Run `scout` on the request: $@
2. Capture the scout's final output as an explicit handoff
3. Run `planner` with the original request plus scout context
4. Run `worker` with:
   - the original request
   - the scout handoff
   - the planner handoff
