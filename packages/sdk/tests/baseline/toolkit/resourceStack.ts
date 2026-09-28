import { warnTeardown } from "./liveRun";

/**
 * Owns resources acquired one after another, releasing them last-first when
 * disposed. Stands in for `AsyncDisposableStack`, which Node 22 lacks. Each
 * release failure is logged, never thrown, so one failure never skips the rest.
 */
export class ResourceStack implements AsyncDisposable {
  private readonly resources: AsyncDisposable[] = [];

  public use<T extends AsyncDisposable>(resource: T): T {
    this.resources.push(resource);
    return resource;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    for (const resource of this.resources.splice(0).reverse()) {
      await Promise.resolve()
        .then(() => resource[Symbol.asyncDispose]())
        .catch(warnTeardown("release resource"));
    }
  }
}
