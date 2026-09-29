"""A headless Parlant server for the baseline's parlant adapter.

The adapter creates its own agent over REST, so the server starts empty.
The `parlant-server` CLI would need the chroma extra; the SDK server does not.
"""

import asyncio
import os

import parlant.sdk as p


async def main() -> None:
    async with p.Server(port=int(os.environ["PARLANT_PORT"]), nlp_service=p.NLPServices.openai):
        pass  # Serves until the process is stopped.


asyncio.run(main())
