import { describe, expect, it } from "vitest";
import { FernRestAdapter } from "../src/client/rest/FernRestAdapter";
import { RestFacade } from "../src/client/rest/RestFacade";
import type { FernBandClientLike } from "../src/client/rest/types";
import { UnsupportedFeatureError } from "../src/core/errors";
import { StubRestApi } from "../src/testing/StubRestApi";

const operations = [
  ["getChatBoard", (api: RestFacade | FernRestAdapter) => api.getChatBoard("room", { include: "history" })],
  ["putChatBoard", (api: RestFacade | FernRestAdapter) => api.putChatBoard("room", { goal_title: "Ship" })],
  ["listChatTasks", (api: RestFacade | FernRestAdapter) => api.listChatTasks("room", { limit: 1, cursor: "next" })],
  ["createChatTask", (api: RestFacade | FernRestAdapter) => api.createChatTask("room", { subject: "Build" })],
  ["getChatTask", (api: RestFacade | FernRestAdapter) => api.getChatTask("room", "3", { include: "history" })],
  ["updateChatTask", (api: RestFacade | FernRestAdapter) => api.updateChatTask("room", "3", { status: "completed" })],
] as const;

describe("board REST boundary", () => {
  it.each(operations)("%s binds Fern and preserves the response including null", async (name, invoke) => {
    const data = { id: "task", superseded_by_id: null, goal_title: null };
    const response = name === "listChatTasks" ? { data: [data], metadata: { next_cursor: null, limit: 1, has_more: false } } : { data };
    const slice = { marker: response, [name]: async function(this: { marker: unknown }, ...args: unknown[]) { expect(args[0]).toBe("room"); return this.marker; } };
    const adapter = new FernRestAdapter({ agentApiChatTasks: slice as FernBandClientLike["agentApiChatTasks"] });
    const facade = new RestFacade({ api: adapter });
    expect(await invoke(facade)).toEqual(name === "listChatTasks" ? response : data);
  });

  it.each(operations)("%s fails clearly when absent and preserves Band error identity", async (name, invoke) => {
    await expect(invoke(new FernRestAdapter({}))).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(invoke(new RestFacade({ api: new StubRestApi() }))).rejects.toBeInstanceOf(UnsupportedFeatureError);
    const error = Object.assign(new Error("Band refused it"), { statusCode: 422, body: { details: { "/subject": ["too long"] } } });
    const adapter = new FernRestAdapter({ agentApiChatTasks: { [name]: async () => { throw error; } } });
    await expect(invoke(new RestFacade({ api: adapter }))).rejects.toBe(error);
  });
});
