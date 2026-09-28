/**
 * Per-room async mutex. One room's turns never overlap; other rooms stay
 * concurrent. A rejected turn does not wedge the room: the tracked tail
 * always settles, and `run` still returns that turn's own result.
 */
export function createRoomTurnLock(): RoomTurnLock {
  const tails = new Map<string, Promise<void>>();
  return {
    async run(roomId, fn) {
      const previous = tails.get(roomId) ?? Promise.resolve();
      const run = previous.then(fn, fn);
      const tail = run.then(() => undefined, () => undefined);
      tails.set(roomId, tail);
      return run;
    },
    release(roomId) {
      const tail = tails.get(roomId);
      if (!tail) {
        return;
      }
      void tail.then(() => {
        if (tails.get(roomId) === tail) {
          tails.delete(roomId);
        }
      });
    },
  };
}

export interface RoomTurnLock {
  run<T>(roomId: string, fn: () => Promise<T>): Promise<T>;
  /** Drop the room once its in-flight turn settles, without cutting off that turn. */
  release(roomId: string): void;
}
