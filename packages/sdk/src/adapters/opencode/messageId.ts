import { randomInt } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// The id carries `milliseconds * COUNTER_RANGE + counter` as its low six bytes of a uint64, so ids made in the
// same millisecond still ascend.
const COUNTER_RANGE = 0x1000n;
const UINT64_BYTES = 8;
const TIME_AND_COUNTER_BYTES = 6;
const RANDOM_SUFFIX_LENGTH = 14;
let lastTimestamp = 0;
let counter = 0;

/** OpenCode's native ascending ID: the time and counter bytes, then a random base62 suffix. */
export function opencodeMessageId(): string {
  const now = Date.now();
  counter = now === lastTimestamp ? counter + 1 : 1;
  lastTimestamp = now;
  const packed = Buffer.alloc(UINT64_BYTES);
  packed.writeBigUInt64BE(BigInt(now) * COUNTER_RANGE + BigInt(counter));
  const suffix = Array.from({ length: RANDOM_SUFFIX_LENGTH }, () => BASE62[randomInt(BASE62.length)]).join("");
  return `msg_${packed.subarray(UINT64_BYTES - TIME_AND_COUNTER_BYTES).toString("hex")}${suffix}`;
}
