import { RoundOutcome as CoreRoundOutcome, type TurnEffect } from "@band-ai/band-sdk-core";

import { isFailedToolOutput } from "../../contracts/protocols";
import { observeTurnEffects, type Turn } from "../../core/turn";

export const DEFAULT_MAX_TOOL_ROUNDS = 8;

/** Facts bound to one round, including calls that settle after its owner moves on. */
export class ToolRoundOutcome {
  private readonly outcome = new CoreRoundOutcome();

  public constructor(private readonly turn: Turn) {}

  public record(output: unknown, effect: TurnEffect = "observe"): boolean {
    const failed = isFailedToolOutput(output);
    this.outcome.record(effect, !failed);
    return failed;
  }

  public fail(): void {
    this.outcome.record("observe", false);
  }

  public run<T>(execute: () => Promise<T>): Promise<T> {
    return observeTurnEffects(this.turn, (effect) => this.outcome.record(effect, true), async () => {
      try {
        const output = await execute();
        this.record(output);
        return output;
      } catch (error) {
        this.fail();
        throw error;
      }
    });
  }

  public shouldStop(complete: boolean): boolean {
    return this.outcome.shouldStop(complete);
  }
}

/** Native loop bookkeeping; Core alone decides whether an observed round stops. */
export class RoundOutcome {
  private rounds = 0;
  private current: ToolRoundOutcome;

  public constructor(private readonly turn: Turn, private readonly maxToolRounds = Number.POSITIVE_INFINITY) {
    this.current = new ToolRoundOutcome(turn);
  }

  public start(): void {
    if (++this.rounds > this.maxToolRounds) {
      throw new Error(`Stopped tool loop after ${this.maxToolRounds} rounds to prevent infinite recursion.`);
    }
    this.current = new ToolRoundOutcome(this.turn);
  }

  public capture(): ToolRoundOutcome {
    return this.current;
  }

  public run<T>(execute: () => Promise<T>): Promise<T> {
    return this.current.run(execute);
  }

  public shouldStop(complete: boolean): boolean {
    return this.current.shouldStop(complete);
  }
}

/** A response may close only the nonempty, unambiguous roster announced for this round. */
export class ToolCallRoster {
  private readonly pending: Set<string>;
  private readonly valid: boolean;

  public constructor(ids: readonly (string | undefined)[], seen: Set<string> = new Set()) {
    this.pending = new Set(ids.filter((id): id is string => Boolean(id)));
    this.valid = ids.length > 0 && this.pending.size === ids.length && !ids.some((id) => id && seen.has(id));
    for (const id of this.pending) seen.add(id);
  }

  public observe(ids: readonly (string | undefined)[]): boolean {
    for (const id of ids) {
      if (id) this.pending.delete(id);
    }
    return this.valid && this.pending.size === 0;
  }
}
