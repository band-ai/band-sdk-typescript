#!/usr/bin/env python3
"""Build packages/sdk/agent_config.yaml from repo .env.test + band-sdk-python agent_config.yaml."""

from __future__ import annotations

import re
import sys
from pathlib import Path

SDK = Path(__file__).resolve().parents[1]
REPO = SDK.parents[1]
PY_REPO = REPO.parent / "band-sdk-python"
ENV_FILE = REPO / ".env.test"
OUT = SDK / "agent_config.yaml"

# Band YAML keys referenced by packages/sdk/examples/**/*.ts
EXAMPLE_KEYS = [
    "basic_agent",
    "openai_agent",
    "anthropic_agent",
    "support_agent",
    "gemini_agent",
    "claude_sdk_agent",
    "codex_agent",
    "langgraph_agent",
    "memory_agent",
    "a2a_bridge_agent",
    "a2a_bridge_auth_agent",
    "a2a_gateway_agent",
    "parlant_agent",
    "custom_adapter_agent",
    "linear_band_bridge",
    "planner_agent",
    "reviewer_agent",
    "linear_band_transport",
    "copilot_acp_agent",
    "omp_acp_agent",
    "letta_agent",
    "tom_agent",
    "jerry_agent",
]

JERRY_KEYS = {
    "jerry_agent",
    "letta_agent",
    "copilot_acp_agent",
    "omp_acp_agent",
    "memory_agent",
    "a2a_bridge_auth_agent",
}


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.is_file():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def parse_profile(py_config: str, name: str) -> tuple[str, str] | None:
    # tom: &tom_profile ... agent_id / api_key before next top-level key
    block = re.search(
        rf"^{name}:\s*(?:&\w+\s*)?(?:#.*\n)?((?:  .+\n)+)",
        py_config,
        re.MULTILINE,
    )
    if not block:
        return None
    body = block.group(1)
    aid = re.search(r'agent_id:\s*([^\s#]+)', body)
    key = re.search(r'api_key:\s*(\S+)', body)
    if not aid or not key:
        return None
    return aid.group(1).strip(), key.group(1).strip()


def main() -> int:
    env = load_env(ENV_FILE)
    ws = env.get("BAND_WS_URL", "")
    rest = env.get("BAND_REST_URL") or env.get("BAND_BASE_URL", "")

    tom = jerry = None
    py_path = PY_REPO / "agent_config.yaml"
    if py_path.is_file():
        py_text = py_path.read_text()
        tom = parse_profile(py_text, "tom") or parse_profile(py_text, "tom_agent")
        jerry = parse_profile(py_text, "jery") or parse_profile(py_text, "jerry_agent")

    if not tom:
        aid = env.get("TEST_AGENT_ID")
        key = env.get("BAND_API_KEY")
        if not aid or not key:
            print("Need band-sdk-python/agent_config.yaml or TEST_AGENT_ID+BAND_API_KEY in .env.test", file=sys.stderr)
            return 1
        tom = (aid, key)

    if not jerry:
        aid = env.get("TEST_AGENT_ID_2") or tom[0]
        key = env.get("BAND_API_KEY_2") or env.get("BAND_API_KEY") or tom[1]
        jerry = (aid, key)

    lines = [
        "# Generated for TS examples — tom/jerry profiles from band-sdk-python when present.",
        "",
        "tom: &tom_profile",
        f'  agent_id: "{tom[0]}"',
        f'  api_key: "{tom[1]}"',
    ]
    if ws:
        lines.append(f'  ws_url: "{ws}"')
    if rest:
        lines.append(f'  rest_url: "{rest}"')
    lines.extend(["", "jery: &jery_profile", f'  agent_id: "{jerry[0]}"', f'  api_key: "{jerry[1]}"'])
    if ws:
        lines.append(f'  ws_url: "{ws}"')
    if rest:
        lines.append(f'  rest_url: "{rest}"')
    lines.append("")

    for key in EXAMPLE_KEYS:
        anchor = "*jery_profile" if key in JERRY_KEYS else "*tom_profile"
        lines.append(f"{key}: {anchor}")
        lines.append("")

    OUT.write_text("\n".join(lines))
    print(f"Wrote {OUT} ({len(EXAMPLE_KEYS)} keys, tom + jerry profiles)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
