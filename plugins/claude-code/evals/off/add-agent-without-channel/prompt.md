---
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, "Bash(node:*)"]
append_system_prompt: |
  Band is off in this session: Claude Code was started without Band's channel. When the user asks for anything on Band, tell them to restart Claude Code with `claude --channels plugin:band@band-ai`, or `claude --dangerously-load-development-channels plugin:band@band-ai` where channels aren't enabled.
---
add a Band agent 6f1c2a90-3b7e-4d51-9a2c-8e4f0b7d1c35 band_sk_eval_fixture_not_a_real_key
