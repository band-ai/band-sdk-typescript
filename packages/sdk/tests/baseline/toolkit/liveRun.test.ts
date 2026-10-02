import { describe, expect, it } from "vitest";

import { releasedWithTest } from "./liveRun";

class Counted implements AsyncDisposable {
  public releases = 0;

  public async [Symbol.asyncDispose](): Promise<void> {
    this.releases += 1;
  }
}

describe("releasedWithTest", () => {
  const abandoned = new Counted();
  const scoped = new Counted();

  it("leaves a resource its test never released held until that test ends", () => {
    releasedWithTest(abandoned);
    expect(abandoned.releases).toBe(0);
  });

  it("released it when that test ended", () => {
    expect(abandoned.releases).toBe(1);
  });

  it("releases a resource once, at its scope, though its test ends after", async () => {
    {
      await using _resource = releasedWithTest(scoped);
    }
    expect(scoped.releases).toBe(1);
  });

  it("did not release it again when that test ended", () => {
    expect(scoped.releases).toBe(1);
  });
});
