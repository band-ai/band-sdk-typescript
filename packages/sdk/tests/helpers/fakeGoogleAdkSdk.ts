import type { GoogleADKAdapterOptions } from "../../src/adapters/google-adk";

type SdkFactory = NonNullable<GoogleADKAdapterOptions["sdkFactory"]>;

export interface GoogleAdkCapture {
  createAgentCalls: Array<Record<string, unknown>>;
  createRunnerCalls: Array<{ appName: string }>;
  createSessionCalls: Array<{ appName: string; userId: string; sessionId: string }>;
}

/** A stand-in for the Google ADK SDK: `run` plays the runner's event stream for each prompt the adapter sends. */
export function createFakeGoogleAdkSdk(
  run: (agent: Record<string, unknown>, request: { userId: string; sessionId: string; newMessage: { role: "user"; parts: Array<{ text: string }> } }) => AsyncIterable<unknown>,
  capture?: GoogleAdkCapture,
): SdkFactory {
  return async () => ({
    createModel: (params: { model: string; apiKey: string }) => ({ gemini: params }),
    createAgent: (params: Record<string, unknown>) => {
      capture?.createAgentCalls?.push(params);
      return params;
    },
    createFunctionTool: (params: Record<string, unknown>) => params,
    createRunner: (params: { agent: Record<string, unknown>; appName: string }) => {
      capture?.createRunnerCalls?.push({ appName: params.appName });
      return {
        sessionService: {
          createSession: async (sessionParams: { appName: string; userId: string; sessionId: string }) => {
            capture?.createSessionCalls?.push(sessionParams);
            return { ok: true };
          },
        },
        runAsync: (request: { userId: string; sessionId: string; newMessage: { role: "user"; parts: Array<{ text: string }> } }) => run(params.agent, request),
      };
    },
    isFinalResponse: (event: Record<string, unknown>) => event.final === true,
    getFunctionCalls: (event: Record<string, unknown>) => Array.isArray(event.functionCalls) ? event.functionCalls : [],
    getFunctionResponses: (event: Record<string, unknown>) => Array.isArray(event.functionResponses) ? event.functionResponses : [],
    stringifyContent: (event: Record<string, unknown>) => String(event.text ?? ""),
  });
}

/** The fake runner, but event inspection goes through the real `@google/adk` helpers, so events take the shape the real runner yields. */
export function createRealEventGoogleAdkSdk(run: Parameters<typeof createFakeGoogleAdkSdk>[0]): SdkFactory {
  return async () => {
    const sdk = await import("@google/adk");
    return {
      ...await createFakeGoogleAdkSdk(run)(),
      getFunctionCalls: (event) => sdk.getFunctionCalls(event as never),
      getFunctionResponses: (event) => sdk.getFunctionResponses(event as never),
      isFinalResponse: (event) => sdk.isFinalResponse(event as never),
      stringifyContent: (event) => sdk.stringifyContent(event as never),
    };
  };
}
