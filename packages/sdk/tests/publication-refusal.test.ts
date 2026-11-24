import { BandError } from "@band-ai/rest-client";
import { expect, it } from "vitest";

import { JournalPublicationError } from "../src/runtime/journal/errors";
import { PublicationEngine } from "../src/runtime/journal/publication";
import { makeLoggerSpy, tmpRoot } from "./testUtils";
import { ROOM, generationIn } from "./turnJournalSupport";

it("logs Band's refusal of a reply when the refusal's record cannot land", async () => {
  const { generation } = await generationIn(tmpRoot());
  const journal = await generation.room(ROOM);
  const logger = makeLoggerSpy();
  const engine = new PublicationEngine({ roomId: ROOM, generation, logger });
  const refusal = new BandError({ statusCode: 422, body: { error: { code: "invalid", message: "Unprocessable" } } });

  // The room's journal closes while Band answers, so the refusal cannot be recorded.
  const outcome = await engine.publishReply("m-1", async () => {
    await journal.close();
    throw refusal;
  }).catch((error: unknown) => error);

  expect(outcome).toBeInstanceOf(JournalPublicationError);
  expect(outcome).toMatchObject({ kind: "closed" });
  expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: refusal, recordError: outcome }));
});
