/**
 * `tools` with some members replaced, via a Proxy over a fresh empty target:
 * `tools` is frozen, so an override cannot live on it.
 * `Reflect.get(tools, key, tools)` keeps inherited accessors/methods bound to
 * the real tools instance.
 */
export function overrideTools<T extends object>(tools: T, overrides: Partial<T>): T {
  return new Proxy({} as T, {
    has(_target, key) {
      return Object.hasOwn(overrides, key) || Reflect.has(tools, key);
    },
    get(_target, key) {
      if (Object.hasOwn(overrides, key)) {
        return overrides[key as keyof T];
      }
      const value: unknown = Reflect.get(tools, key, tools);
      return typeof value === "function" ? (value.bind(tools) as unknown) : value;
    },
    // Without this, a write against the empty target would silently succeed
    // and vanish — invisible even to the handler that made it, since `get`
    // never consults the target. `tools` is frozen, so forwarding here
    // throws the same `TypeError` a write against the real, unwrapped
    // `tools` always has.
    set(_target, key, value) {
      return Reflect.set(tools, key, value, tools);
    },
    // Without these two traps, `Object.keys`/spread/`Object.assign` fall back
    // to the empty target's own keys — reporting no properties at all, even
    // though `has`/`get` resolve every one of them. `configurable: true` is
    // required, not a choice: the target has no own properties of its own, so
    // the Proxy invariants forbid reporting any key as non-configurable.
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(tools), ...Reflect.ownKeys(overrides)])];
    },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Object.hasOwn(overrides, key)
        ? Reflect.getOwnPropertyDescriptor(overrides, key)
        : Reflect.getOwnPropertyDescriptor(tools, key);
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}
