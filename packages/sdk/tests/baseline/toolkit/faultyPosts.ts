/**
 * An agent's real REST client whose first message post fails the way Band's can
 * leave its outcome unknown. Every other request, and every later post, reaches
 * Band untouched. Handed to the agent through `RunOptions.restApi`.
 */
import type { FernRestAdapter } from "../../../src/rest";
import { agentRest } from "../../integration/support/liveHarness";
import type { AgentIdentity } from "./agents";
import { liveRun } from "./liveRun";

export const POST_FAULT = {
  /** The post reaches Band and is stored; its response never arrives. */
  lostAfterCommit: "lostAfterCommit",
  /** Answered 503 before reaching Band, so nothing is stored. */
  unavailableBeforeCommit: "unavailableBeforeCommit",
} as const;
export type PostFault = (typeof POST_FAULT)[keyof typeof POST_FAULT];

const SERVICE_UNAVAILABLE = 503;
const MESSAGE_POST = /\/agent\/chats\/[^/]+\/messages$/;

export class FaultyPosts {
  /** A REST client acting as the agent, whose first message post fails. */
  public readonly rest: FernRestAdapter;
  /** The message POSTs the agent attempted. */
  public attempts = 0;

  private constructor(restUrl: string, identity: AgentIdentity, private readonly fault: PostFault) {
    this.rest = agentRest(restUrl, identity.apiKey, undefined, this.fetch);
  }

  public static async create(identity: AgentIdentity, fault: PostFault): Promise<FaultyPosts> {
    const { env } = await liveRun();
    return new FaultyPosts(env.restUrl, identity, fault);
  }

  private readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    if ((init?.method ?? "GET") !== "POST" || !MESSAGE_POST.test(new URL(url).pathname)) return fetch(input, init);
    this.attempts += 1;
    if (this.attempts > 1) return fetch(input, init);
    if (this.fault === POST_FAULT.unavailableBeforeCommit) {
      return new Response(JSON.stringify({ error: { code: "service_unavailable", message: "Unavailable" } }), {
        status: SERVICE_UNAVAILABLE,
        headers: { "content-type": "application/json" },
      });
    }
    const response = await fetch(input, init);
    await response.body?.cancel();
    throw new TypeError(`the response to a committed post (status ${response.status}) was lost`);
  }) as typeof fetch;
}
