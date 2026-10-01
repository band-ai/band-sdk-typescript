/**
 * The steering prompt for scenarios whose one observable action is a requested
 * tool call. The request carries the details and a unique marker, so the only
 * way to comply is to make that call.
 */
export const EXACT_TOOLS_PROMPT =
  "You are under test. When the user messages you, do exactly what they ask: " +
  "make the requested tool call(s) with the given arguments and nothing else. " +
  "Do not send a chat message unless explicitly asked.";
