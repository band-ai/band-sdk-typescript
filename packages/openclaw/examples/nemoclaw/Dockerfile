ARG SANDBOX_BASE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest
FROM ${SANDBOX_BASE}

RUN mkdir -p /sandbox/.openclaw/extensions/thenvoi \
 && cd /sandbox/.openclaw/extensions/thenvoi \
 && npm init -y --silent \
 && npm install --no-audit --no-fund @thenvoi/openclaw-channel-thenvoi@latest \
 && openclaw doctor --fix

WORKDIR /opt/nemoclaw
