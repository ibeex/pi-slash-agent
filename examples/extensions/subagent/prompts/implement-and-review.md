---
description: Reference for the built-in /implement-and-review workflow
---
This workflow is now implemented directly by the extension as a slash command.

Preferred usage:

```text
/implement-and-review $@
```

Behavior:
1. Run `worker` to implement: $@
2. Capture the worker's final output as an explicit handoff
3. Run `reviewer` with the original request plus the worker handoff
4. Run `worker` again with:
   - the original request
   - the previous worker summary
   - the reviewer feedback
