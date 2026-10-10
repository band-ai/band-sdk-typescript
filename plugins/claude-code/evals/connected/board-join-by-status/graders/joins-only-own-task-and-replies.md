---
type: llm
focus: trace
---
Pass only if the worker reads the board or task list before joining, calls update_task only for #2 (or 2 or its UUID task-open-2) with its own status in_progress and an active_form, never edits #1, never changes the goal or task subjects, details or lifecycle states, and confirms using reply with message_id msg-board-202. A terminal-only answer fails. Assignment is by the caller's own status; no request to assign another agent should be sent.
