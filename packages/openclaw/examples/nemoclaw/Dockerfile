# Unsupported. NemoClaw 0.0.124 treats a custom Dockerfile as the complete
# sandbox image and will not start the managed OpenClaw gateway from this
# base-only file. Follow packages/openclaw/examples/nemoclaw/README.md:
# onboard the stock OpenClaw runtime, then install the Band plugin inside it.
#
# This file is kept only so accidental `nemoclaw onboard --from ./Dockerfile`
# fails closed with an explicit message instead of a silent half-image.
FROM scratch
LABEL org.opencontainers.image.description="Unsupported base — see README.md (stock NemoClaw onboard only)"
