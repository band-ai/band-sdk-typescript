ARG SANDBOX_BASE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest
FROM ${SANDBOX_BASE}

RUN mkdir -p /sandbox/.openclaw/extensions/band \
 && cd /sandbox/.openclaw/extensions/band \
 && npm init -y --silent \
 && npm install --no-audit --no-fund @band-ai/openclaw-channel-band@latest \
 && openclaw doctor --fix

WORKDIR /opt/nemoclaw
