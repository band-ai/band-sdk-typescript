import { RuntimeStateError } from "../../core/errors";

interface LazyAsyncValueOptions<T> {
  load: () => Promise<T>;
  onRejected?: (error: unknown) => void;
  retryBackoffMs?: number;
}

const DEFAULT_RETRY_BACKOFF_MS = 1_000;

/**
 * A value produced once by an async loader and then cached, with concurrent callers
 * sharing one in-flight load. A failed load is retried, but not before a backoff window
 * has passed, so a broken dependency is not hammered on every message.
 */
export class LazyAsyncValue<T> {
  private readonly load: () => Promise<T>;
  private readonly onRejected?: (error: unknown) => void;
  private readonly retryBackoffMs: number;
  private value: T | null = null;
  private pending: Promise<T> | null = null;
  private lastFailureAt = 0;

  public constructor(options: LazyAsyncValueOptions<T>) {
    this.load = options.load;
    this.onRejected = options.onRejected;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  public get current(): T | null {
    return this.value;
  }

  public async get(): Promise<T> {
    if (this.value) {
      return this.value;
    }

    if (!this.pending) {
      if (this.lastFailureAt > 0 && Date.now() - this.lastFailureAt < this.retryBackoffMs) {
        throw new RuntimeStateError(
          `LazyAsyncValue load failed recently; retrying after ${this.retryBackoffMs}ms backoff.`,
        );
      }

      this.pending = this.load()
        .then((value) => {
          this.value = value;
          this.lastFailureAt = 0;
          return value;
        })
        .catch((error: unknown) => {
          this.pending = null;
          this.lastFailureAt = Date.now();
          this.onRejected?.(error);
          throw error;
        });
    }

    return this.pending;
  }

  public clear(): void {
    this.value = null;
    this.pending = null;
    this.lastFailureAt = 0;
  }
}
