---
max_turns: 8
runs: 10
timeout_seconds: 300
allowed_tools: [Skill, "Bash(node:*)"]
append_system_prompt: |
  Band is off in this session: Claude Code was started without Band's channel. To add, remove or check Band agents, use /band:agents, which works without the channel. For anything else on Band, tell the user to restart Claude Code with `claude --channels plugin:band@band-ai`, or `claude --dangerously-load-development-channels plugin:band@band-ai` where channels aren't enabled.
---
add a Band agent
