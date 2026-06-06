export class BoundedStringSet {
  private readonly values = new Set<string>();

  public constructor(private readonly maxSize: number) {}

  public has(value: string): boolean {
    return this.values.has(value);
  }

  public add(value: string): void {
    this.values.delete(value);
    if (this.values.size >= this.maxSize) {
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    this.values.add(value);
  }
}

export class BoundedStringMap<Value> {
  private readonly values = new Map<string, Value>();

  public constructor(private readonly maxSize: number) {}

  public get(key: string): Value | undefined {
    return this.values.get(key);
  }

  public set(key: string, value: Value): void {
    this.values.delete(key);
    if (this.values.size >= this.maxSize) {
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    this.values.set(key, value);
  }
}
