/** Tool rounds a model may run in one turn before its loop is stopped as runaway. */
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

/** What a tool loop throws when the model asks for a round past `maxToolRounds`. */
export function toolLoopLimitError(maxToolRounds: number): Error {
  return new Error(`Stopped tool loop after ${maxToolRounds} rounds to prevent infinite recursion.`);
}
