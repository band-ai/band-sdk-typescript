/**
 * Kick off a 20 Questions Arena game as a *user*.
 *
 * Creates a new chat room, adds the configured Thinker and Guesser agents
 * as participants, then sends a "start a new game" message that mentions
 * the Thinker and all guessers.
 *
 * Usage:
 *   pnpm --dir packages/sdk exec tsx examples/20-questions-arena/start-game.ts <user_api_key>
 *
 * Environment:
 *   THENVOI_REST_URL  required — REST base URL (e.g. https://app.thenvoi.com)
 *
 * Config keys read from agent_config.yaml (or env fallback):
 *   arena_thinker      required — Thinker agent
 *   arena_guesser      optional — first guesser
 *   arena_guesser_2    optional — additional guessers
 *   arena_guesser_3
 *   arena_guesser_4
 *
 * At least one guesser must be configured.
 */
import { isDirectExecution, loadAgentConfig } from "@thenvoi/sdk";
import { ThenvoiClient } from "@thenvoi/rest-client";

const GUESSER_KEYS = [
  "arena_guesser",
  "arena_guesser_2",
  "arena_guesser_3",
  "arena_guesser_4",
] as const;

function tryLoadAgentId(configKey: string): string | null {
  try {
    return loadAgentConfig(configKey).agentId;
  } catch {
    return null;
  }
}

export interface StartGameResult {
  chatId: string;
  thinkerId: string;
  guesserIds: string[];
}

export async function startGame(userApiKey: string): Promise<StartGameResult> {
  const restUrl = process.env.THENVOI_REST_URL;
  if (!restUrl) {
    throw new Error("THENVOI_REST_URL environment variable is required");
  }

  const thinkerId = tryLoadAgentId("arena_thinker");
  if (!thinkerId) {
    throw new Error(
      "arena_thinker entry is required in agent_config.yaml.",
    );
  }

  const guesserIds: string[] = [];
  for (const key of GUESSER_KEYS) {
    const id = tryLoadAgentId(key);
    if (id) {
      guesserIds.push(id);
    } else {
      console.log(`Skipping ${key} (not configured)`);
    }
  }

  if (guesserIds.length === 0) {
    throw new Error(
      `At least one guesser key (${GUESSER_KEYS.join(", ")}) must be configured.`,
    );
  }

  const client = new ThenvoiClient({ apiKey: userApiKey, baseUrl: restUrl });

  const chatResp = await client.humanApiChats.createMyChatRoom({ chat: {} });
  const chatId = (chatResp.data as { id: string }).id;
  console.log("Created chat room:", chatId);

  await client.humanApiParticipants.addMyChatParticipant(chatId, {
    participant: { participant_id: thinkerId, role: "member" },
  });
  console.log("Added Thinker to room");

  for (const guesserId of guesserIds) {
    await client.humanApiParticipants.addMyChatParticipant(chatId, {
      participant: { participant_id: guesserId, role: "member" },
    });
  }
  console.log(`Added ${guesserIds.length} guesser(s) to room`);

  const partsResp = await client.humanApiParticipants.listMyChatParticipants(chatId);
  const participants = (partsResp.data as Array<{ id: string; name: string }>) ?? [];

  const byId = new Map<string, { id: string; name: string }>();
  for (const p of participants) {
    byId.set(String(p.id), p);
  }

  const thinker = byId.get(thinkerId);
  const thinkerName = thinker?.name ?? "Thinker";
  const mentions: Array<{ id: string; name?: string }> = [
    { id: thinker?.id ?? thinkerId, name: thinkerName },
  ];

  const guesserNames: string[] = [];
  for (const gid of guesserIds) {
    const g = byId.get(gid);
    if (g) {
      mentions.push({ id: g.id, name: g.name });
      guesserNames.push(g.name);
    }
  }

  console.log("Thinker:", thinkerName);
  console.log("Guessers:", guesserNames.join(", "));

  const msgResp = await client.humanApiMessages.sendMyChatMessage(chatId, {
    message: {
      content: `@${thinkerName} start a new game of 20 questions with all the guessers in this room!`,
      mentions,
    },
  });
  console.log("Sent start message:", (msgResp.data as { id: string }).id);

  return { chatId, thinkerId, guesserIds };
}

if (isDirectExecution(import.meta.url)) {
  const userApiKey = process.argv[2];
  if (!userApiKey) {
    throw new Error("Usage: tsx start-game.ts <user_api_key>");
  }

  void startGame(userApiKey).then((result) => {
    console.log("Game started in room:", result.chatId);
  });
}
