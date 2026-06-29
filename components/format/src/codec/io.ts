/**
 * Low-level byte I/O for the capture codec: a growable `Writer`, a bounds-checked `Reader`, the
 * shared string-interning table, and the `Encoder`/`Decoder` wrappers the schema layer builds on.
 *
 * Everything here is hand-rolled and zero-dependency on purpose: the pack path runs on a real user's
 * page (AGENTS "tiny on the page" + "prefer a small vendored varint over a dependency"), so the
 * encoder must be small, tree-shakeable, and free of any runtime import. The decoder runs in tooling
 * and favors clarity. The two halves of every primitive live next to each other so a reader can see
 * that they are exact inverses — the round-trip test is what proves it.
 */

import type { RelMs, DurationMs } from '../time.js';

/**
 * Growable little-endian byte sink. Capacity doubles on demand; `finish()` returns a view of exactly
 * the written bytes (no copy). Numbers are written as LEB128 varints (the small non-negative integers
 * that dominate: counts, ids, sizes, string refs), zigzag varints (the fixed-point µs timeline ticks —
 * see `Encoder.rel`/`dur`), or 8-byte IEEE-754 doubles (wall-clock `EpochMs` plus true floats — rects,
 * ratios, CLS value — that can be fractional or negative and are not on the µs timeline grid).
 */
export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b & 0xff;
  }

  /**
   * Unsigned LEB128. Uses `% 128` / `Math.floor(n / 128)` rather than `& 0x7f` / `>>> 7` so values
   * above 2^32 (e.g. large `decodedBodySize`) survive — JS bitwise ops truncate to 32 bits and would
   * corrupt them silently. Non-integer or negative input is a programming error (a field was routed
   * to the wrong writer); we throw loudly rather than encode a wrong value.
   */
  varuint(n: number): void {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`varuint expects a non-negative integer, got ${n}`);
    }
    this.ensure(10); // ceil(53/7) = 8 bytes max for a safe integer; 10 is comfortable headroom
    while (n >= 0x80) {
      this.buf[this.pos++] = (n % 128) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.pos++] = n;
  }

  /**
   * Signed LEB128 via zigzag (…, -2→3, -1→1, 0→0, 1→2, 2→4, …). Uses `* 2` / `* -2 - 1` rather than
   * `<< 1` / `>> 31` so it stays correct past 2^32 — a microsecond timestamp for a multi-minute
   * session already exceeds 2^31. Small magnitudes (the common case after delta-encoding) stay 1 byte.
   */
  zigzag(n: number): void {
    if (!Number.isInteger(n)) throw new RangeError(`zigzag expects an integer, got ${n}`);
    this.varuint(n >= 0 ? n * 2 : n * -2 - 1);
  }

  /** 8-byte IEEE-754 double, little-endian. Lossless for every JS number, including NaN and -0. */
  f64(x: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, x, true);
    this.pos += 8;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

/** Cursor over a byte buffer. Every read is bounds-checked so a truncated/corrupt file fails loudly. */
export class Reader {
  private readonly view: DataView;
  pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get atEnd(): boolean {
    return this.pos >= this.buf.length;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new RangeError('unexpected end of capture data');
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  varuint(): number {
    let result = 0;
    let scale = 1;
    let byte: number;
    do {
      this.need(1);
      byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * scale; // multiply, not shift: stays correct past 2^32
      scale *= 128;
    } while (byte & 0x80);
    return result;
  }

  zigzag(): number {
    const u = this.varuint();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/**
 * String interning. URLs, resource names, selectors, initiator/protocol/invoker strings and the
 * format's many small enum literals repeat heavily across a capture; storing each once and referring
 * to it by a varint id is the codec's single biggest size lever. Ids are assigned in first-seen order
 * during the encode pass, so the table can only be serialized once that pass is complete — which is
 * why the string-table section is emitted last but placed first in the file (see pack.ts). The empty
 * string is a normal, distinct value (e.g. `deliveryType: ''`) and interns like any other; "absent"
 * is carried by presence bits, never by the table.
 */
export class StringTable {
  private readonly index = new Map<string, number>();
  private readonly list: string[] = [];

  intern(s: string): number {
    let id = this.index.get(s);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(s);
      this.index.set(s, id);
    }
    return id;
  }

  encode(w: Writer): void {
    const enc = new TextEncoder();
    w.varuint(this.list.length);
    for (const s of this.list) {
      const b = enc.encode(s);
      w.varuint(b.length);
      w.bytes(b);
    }
  }

  static decode(r: Reader): string[] {
    const dec = new TextDecoder();
    const n = r.varuint();
    const list = new Array<string>(n);
    for (let i = 0; i < n; i++) {
      const len = r.varuint();
      list[i] = dec.decode(r.bytes(len));
    }
    return list;
  }
}

/**
 * Encoder = a byte `Writer` plus the capture-wide `StringTable`. One `Encoder` is created per section
 * (manifest, each stream, overhead) but they all share the same table, so a URL seen in `resources`
 * and again in `lcp` is stored once. This per-section split is also the incremental seam: a future
 * on-page driver can finalize each stream's bytes as that stream completes and only flush the (cheap)
 * string table at pagehide — never a big synchronous pack at unload (AGENTS "no unload cliff").
 */
/**
 * Timeline timestamps are stored as fixed-point **integer microseconds** (zigzag varint), NOT raw
 * f64. Browsers coarsen `DOMHighResTimeStamp` to 100µs by default and at best 5µs when cross-origin
 * isolated (W3C High Resolution Time; verified against MDN + the Chrome cross-origin-isolated-timer
 * blog), so 1µs granularity captures everything real and the extra f64 digits are float noise, not
 * signal. Integer µs is ~2-4 bytes vs 8, makes deltas trivial, and `round(ms * 1000) / 1000` recovers
 * the canonical double exactly for any ≤1µs-resolution value. Only the branded `RelMs`/`DurationMs`
 * timeline values go through here; wall-clock `EpochMs` and true floats (rects, CLS value, ratios)
 * stay f64. Sign is supported (a `ContextClock.offsetToPage` can be negative).
 */
const US_PER_MS = 1000;
const toTicks = (ms: number): number => Math.round(ms * US_PER_MS);
const fromTicks = (us: number): number => us / US_PER_MS;

export class Encoder {
  readonly w = new Writer();
  constructor(readonly strings: StringTable) {}

  u8(b: number): void {
    this.w.u8(b);
  }
  varuint(n: number): void {
    this.w.varuint(n);
  }
  zigzag(n: number): void {
    this.w.zigzag(n);
  }
  f64(x: number): void {
    this.w.f64(x);
  }
  /** A point on the page timeline (RelMs) as integer-µs ticks. */
  rel(x: RelMs): void {
    this.w.zigzag(toTicks(x));
  }
  /** A duration (DurationMs) as integer-µs ticks. */
  dur(x: DurationMs): void {
    this.w.zigzag(toTicks(x));
  }
  bool(b: boolean): void {
    this.w.u8(b ? 1 : 0);
  }
  /** Intern `s` and write its varint id. All string-typed fields, including enum literals, go here. */
  str(s: string): void {
    this.w.varuint(this.strings.intern(s));
  }
  strArray(arr: readonly string[]): void {
    this.w.varuint(arr.length);
    for (const s of arr) this.str(s);
  }

  /**
   * Write a presence bitmap for a struct's optional fields, in declared order. Absent optionals then
   * cost one bit and nothing else — the "truly optional on the wire" tenet. A byte array (not a 32-bit
   * int) backs it so structs with >32 optionals (ResourceTiming has ~28, Navigation more) are fine.
   */
  presence(flags: readonly boolean[]): void {
    const n = flags.length;
    for (let i = 0; i < n; i += 8) {
      let b = 0;
      for (let j = 0; j < 8 && i + j < n; j++) if (flags[i + j]) b |= 1 << j;
      this.w.u8(b);
    }
  }
}

/** Decoder = a `Reader` plus the already-decoded string table. The mirror of `Encoder`. */
export class Decoder {
  constructor(
    readonly r: Reader,
    readonly strings: readonly string[],
  ) {}

  u8(): number {
    return this.r.u8();
  }
  varuint(): number {
    return this.r.varuint();
  }
  zigzag(): number {
    return this.r.zigzag();
  }
  f64(): number {
    return this.r.f64();
  }
  /** A page-timeline point (RelMs) decoded from integer-µs ticks. */
  rel(): RelMs {
    return fromTicks(this.r.zigzag()) as RelMs;
  }
  /** A duration (DurationMs) decoded from integer-µs ticks. */
  dur(): DurationMs {
    return fromTicks(this.r.zigzag()) as DurationMs;
  }
  bool(): boolean {
    return this.r.u8() !== 0;
  }
  str(): string {
    const id = this.r.varuint();
    const s = this.strings[id];
    if (s === undefined) throw new RangeError(`string id ${id} out of range`);
    return s;
  }
  /** `str()` with the literal-union cast the schema layer wants (the byte came from a valid value). */
  enum<T extends string>(): T {
    return this.str() as T;
  }
  strArray(): string[] {
    const n = this.r.varuint();
    const out = new Array<string>(n);
    for (let i = 0; i < n; i++) out[i] = this.str();
    return out;
  }
  presence(n: number): boolean[] {
    const flags = new Array<boolean>(n);
    for (let i = 0; i < n; i += 8) {
      const b = this.r.u8();
      for (let j = 0; j < 8 && i + j < n; j++) flags[i + j] = (b & (1 << j)) !== 0;
    }
    return flags;
  }
}

/**
 * `JsonValue` codec for User Timing `detail`. A 1-byte tag discriminates the JSON shape so that
 * `null` stays distinct from an absent field (the presence bit), and an object key set round-trips
 * exactly. Numbers are stored as f64 (JSON numbers are doubles; this is lossless and detail payloads
 * are small, so a tighter int path isn't worth the branch). Keys are interned like any other string.
 */
import type { JsonValue } from '../json.js';

const JSON_NULL = 0;
const JSON_FALSE = 1;
const JSON_TRUE = 2;
const JSON_NUMBER = 3;
const JSON_STRING = 4;
const JSON_ARRAY = 5;
const JSON_OBJECT = 6;

export function encodeJson(e: Encoder, v: JsonValue): void {
  if (v === null) {
    e.u8(JSON_NULL);
  } else if (v === false) {
    e.u8(JSON_FALSE);
  } else if (v === true) {
    e.u8(JSON_TRUE);
  } else if (typeof v === 'number') {
    e.u8(JSON_NUMBER);
    e.f64(v);
  } else if (typeof v === 'string') {
    e.u8(JSON_STRING);
    e.str(v);
  } else if (Array.isArray(v)) {
    e.u8(JSON_ARRAY);
    e.varuint(v.length);
    for (const item of v) encodeJson(e, item);
  } else {
    const keys = Object.keys(v);
    e.u8(JSON_OBJECT);
    e.varuint(keys.length);
    for (const k of keys) {
      e.str(k);
      encodeJson(e, v[k]!);
    }
  }
}

export function decodeJson(d: Decoder): JsonValue {
  const tag = d.u8();
  switch (tag) {
    case JSON_NULL:
      return null;
    case JSON_FALSE:
      return false;
    case JSON_TRUE:
      return true;
    case JSON_NUMBER:
      return d.f64();
    case JSON_STRING:
      return d.str();
    case JSON_ARRAY: {
      const n = d.varuint();
      const arr: JsonValue[] = new Array<JsonValue>(n);
      for (let i = 0; i < n; i++) arr[i] = decodeJson(d);
      return arr;
    }
    case JSON_OBJECT: {
      const n = d.varuint();
      const obj: { [key: string]: JsonValue } = {};
      for (let i = 0; i < n; i++) {
        const k = d.str();
        obj[k] = decodeJson(d);
      }
      return obj;
    }
    default:
      throw new RangeError(`unknown JSON tag ${tag}`);
  }
}
