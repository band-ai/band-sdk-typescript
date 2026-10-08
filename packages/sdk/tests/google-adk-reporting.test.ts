import { describe, expect, it } from "vitest";
import {
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createEvent,
  functionsExportedForTestingOnly,
  getFunctionCalls,
  getFunctionResponses,
} from "@google/adk";

import { GoogleADKAdapter } from "../src/adapters/google-adk/GoogleADKAdapter";
import { SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import { createToolExecutorError } from "../src/contracts/protocols";
import { FakeTools, makeMessage } from "./testUtils";
import { createFakeGoogleAdkSdk } from "./helpers/fakeGoogleAdkSdk";

const SEND_ARGS = { content: "pineapple", mentions: ["@jane"] };
const CALL_ID = "send-1";

async function reportedResult(output: unknown, throws = false) {
  const tools = new FakeTools();
  tools.getOpenAIToolSchemas = () => [{ type: "function", function: {
    name: SEND_MESSAGE_TOOL_NAME,
    description: "Send a reply",
    parameters: { type: "object", properties: {}, required: [] },
  } }];
  tools.executeToolCall = async () => {
    if (throws) throw new Error("native execution failed");
    return output;
  };
  let upstreamResponse: unknown;
  const fakeSdk = createFakeGoogleAdkSdk(async function* (params) {
    const tool = (params.tools as Array<InstanceType<typeof FunctionTool>>)[0]!;
    const agent = new LlmAgent({ name: "helper", model: "unused", tools: [tool] });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({ appName: "band", userId: "room", sessionId: "session" });
    const invocationContext = new InvocationContext({ invocationId: "invocation", agent, session, sessionService, pluginManager: new PluginManager() });
    const call = { id: CALL_ID, name: SEND_MESSAGE_TOOL_NAME, args: SEND_ARGS };
    yield createEvent({ author: "helper", content: { role: "model", parts: [{ functionCall: call }] } });
    const response = await functionsExportedForTestingOnly.handleFunctionCallList({
      invocationContext,
      functionCalls: [call],
      toolsDict: { [SEND_MESSAGE_TOOL_NAME]: tool },
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    upstreamResponse = getFunctionResponses(response!)[0]?.response;
    yield response;
  });
  const adapter = new GoogleADKAdapter({
    enableExecutionReporting: true,
    sdkFactory: async () => ({
      ...await fakeSdk(),
      createFunctionTool: (params) => new FunctionTool(params),
      getFunctionCalls: (event) => getFunctionCalls(event as Parameters<typeof getFunctionCalls>[0]),
      getFunctionResponses: (event) => getFunctionResponses(event as Parameters<typeof getFunctionResponses>[0]),
    }),
  });
  await adapter.onStarted("helper", "assistant");
  await adapter.onMessage(makeMessage("reply pineapple"), tools, [], null, null, { isSessionBootstrap: true, roomId: "room" });
  const call = tools.events.find((event) => event.messageType === "tool_call");
  expect(JSON.parse(call!.content)).toEqual({ name: SEND_MESSAGE_TOOL_NAME, args: SEND_ARGS, tool_call_id: CALL_ID });
  const result = tools.events.find((event) => event.messageType === "tool_result");
  return { reported: JSON.parse(result!.content), upstreamResponse };
}

describe("Google ADK execution reporting through the installed FunctionTool", () => {
  it("unwraps a successful Band result for reporting while preserving ADK's model-facing JSON string", async () => {
    const output = { id: "reply-id", success: true, recipients: [{ id: "jane-id", handle: "jane" }] };
    const { reported, upstreamResponse } = await reportedResult(output);
    expect(upstreamResponse).toEqual({ result: JSON.stringify(output, null, 2) });
    expect(reported).toEqual({ name: SEND_MESSAGE_TOOL_NAME, output, tool_call_id: CALL_ID, is_error: false });
  });

  it("retains typed Band failures and marks them as errors", async () => {
    const output = createToolExecutorError({ errorType: "ToolExecutionError", toolName: SEND_MESSAGE_TOOL_NAME, message: "cannot_mention_self" });
    const { reported, upstreamResponse } = await reportedResult(output);
    expect(upstreamResponse).toEqual({ result: JSON.stringify(output, null, 2) });
    expect(reported.output).toEqual(output);
    expect(reported.is_error).toBe(true);
    expect(reported.tool_call_id).toBe(CALL_ID);
  });

  it("preserves and flags ADK's native execution error envelope", async () => {
    const { reported, upstreamResponse } = await reportedResult(undefined, true);
    expect(upstreamResponse).toEqual({ error: expect.stringContaining("native execution failed") });
    expect(reported.output).toEqual(upstreamResponse);
    expect(reported.is_error).toBe(true);
  });

  it("flags a wrapped legacy tool failure without changing its model-facing envelope", async () => {
    const { reported, upstreamResponse } = await reportedResult("Error executing band_send_message: denied");
    expect(reported.output).toEqual(upstreamResponse);
    expect(reported.is_error).toBe(true);
  });

  it("keeps malformed wrapped output visible without manufacturing a success", async () => {
    const { reported, upstreamResponse } = await reportedResult("not JSON");
    expect(upstreamResponse).toEqual({ result: "not JSON" });
    expect(reported.output).toEqual(upstreamResponse);
    expect(reported.output).not.toHaveProperty("id");
  });
});
