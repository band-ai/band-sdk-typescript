/**
 * A promise whose resolution is exposed to the caller instead of hidden
 * inside an executor, for cases where something else's callback (not the
 * creator) determines when the operation completes.
 */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
