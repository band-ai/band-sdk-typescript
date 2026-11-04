import { isFailedToolOutput } from "../../contracts/protocols";
import type { Turn } from "../../core/turn";

/** Tool rounds a model may run in one turn before its loop is stopped as runaway. */
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

/** What a tool loop throws when the model asks for a round past `maxToolRounds`. */
function toolLoopLimitError(maxToolRounds: number): Error {
  return new Error(`Stopped tool loop after ${maxToolRounds} rounds to prevent infinite recursion.`);
}

/**
 * The round rule of docs/turn-outcome.md for a loop the SDK drives: a round
 * ends the turn when a decline landed in it and no call beside it failed, so
 * the model still sees a failure. Each call is judged from its own output,
 * as `Turn` judged it, never from a framework's re-encoding of it. It can
 * also cap the rounds a turn may run.
 */
export class RoundOutcome {
  private rounds = 0;
  private declinesBefore = 0;
  private failed = false;

  /** Without `maxToolRounds`, the rounds are left to the framework's own cap. */
  public constructor(private readonly turn: Turn, private readonly maxToolRounds = Number.POSITIVE_INFINITY) {}

  /** Opens a round, before any of its calls run; throws once the model asks for one past the cap. */
  public start(): void {
    if (++this.rounds > this.maxToolRounds) {
      throw toolLoopLimitError(this.maxToolRounds);
    }
    this.declinesBefore = this.turn.declines;
    this.failed = false;
  }

  /** Records one call's output; returns whether the call failed. */
  public record(output: unknown): boolean {
    const failed = isFailedToolOutput(output);
    this.failed ||= failed;
    return failed;
  }

  /** Runs one call, counting a throw as a failed call before rethrowing it to the framework. */
  public async run<T>(execute: () => Promise<T>): Promise<T> {
    try {
      const output = await execute();
      this.record(output);
      return output;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  /** A decline landed this round and nothing beside it failed: the turn is over. */
  public get declined(): boolean {
    return this.turn.declines > this.declinesBefore && !this.failed;
  }
}
