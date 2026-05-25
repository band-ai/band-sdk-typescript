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
      if (oldest) this.values.delete(oldest);
    }
    this.values.add(value);
  }
}
