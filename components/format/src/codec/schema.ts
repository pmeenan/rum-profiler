/**
 * Schema layer — DESCRIPTOR-DRIVEN. Every struct in the capture model is a compact data table
 * (a `Desc`); one generic walker encodes and one decodes by interpreting the table. This replaces ~54
 * hand-written encode/decode pairs, which matters because the encode path ships on third-party pages:
 * the batched-presence-bitmap design otherwise forces each field name to appear ~3× in code (build the
 * bitmap, guard the write, do the write); a table lists it ONCE. It also makes encode/decode drift
 * impossible — both sides read the same descriptor.
 *
 * A `Desc` is `[requiredCount, key, type, key, type, ...]`. The first `requiredCount` fields are
 * written unconditionally; the rest are optional and gated by a presence bitmap (so an absent field
 * costs one bit). A field's `type` is one of:
 *   - a primitive code (number): S str · R relMs · D durMs · U varuint · F f64 · B bool · J json · SA str[]
 *   - a special-handler tag (string): see SPECIAL below (the few cases a flat table can't express)
 *   - a nested `Desc` (its `[0]` is a number) → a sub-struct
 *   - a one-element `[Desc]` (its `[0]` is an array) → an array of that sub-struct
 *
 * The wire format is UNCHANGED from the explicit version — field order, presence order, and per-field
 * writer all match — so the golden-corpus round-trip + byte-determinism tests validate this verbatim.
 * `S`/`R`/`D`/... choose a writer exactly as before: `R`/`D` are fixed-point µs (RelMs/DurationMs),
 * `F` is f64 (EpochMs + true floats), `U` is varuint (counts/sizes/ids).
 */

import type { Encoder, Decoder } from './io.js';
import { encodeJson, decodeJson } from './io.js';
import { STREAM_IDS, type StreamId } from '../registry.js';
import type { RelMs, DurationMs } from '../time.js';
import type { JsonValue } from '../json.js';
import type { Manifest } from '../manifest.js';
import type { OverheadReport } from '../capture.js';

// StreamId -> its index in STREAM_IDS, for the compact stream-reference bytes (section headers, the
// per-stream config/overhead maps).
export const STREAM_INDEX: Record<StreamId, number> = Object.fromEntries(
  STREAM_IDS.map((id, i) => [id, i]),
) as Record<StreamId, number>;

// ── Field type codes (primitive writers) ───────────────────────────────────────────────────────────
const S = 0; // interned string (incl. enum literals)
const R = 1; // RelMs   — fixed-point µs
const D = 2; // DurationMs — fixed-point µs
const U = 3; // varuint — non-negative integer
const F = 4; // f64     — EpochMs + true floats (rects, ratios, CLS value)
const B = 5; // bool
const J = 6; // JsonValue (User Timing detail)
const SA = 7; // string[]

// Special-handler tags — the few shapes a flat table can't express (recursive tree, keyed maps,
// columnar delta). Strings so they're distinct from primitive codes (number) and descriptors (array).
const NRR = 'n'; // navigation.notRestoredReasons: NotRestoredReasons | null (recursive, null-discriminated)
const SMAP = 'm'; // CaptureConfig.streams: Partial<Record<StreamId, StreamConfig>>
const OMAP = 'o'; // OverheadReport.byStream: Partial<Record<StreamId, {...}>>
const PSLICES = 'q'; // SliceProfile.slices: columnar (frameId / depth / start-delta / duration)

type Desc = readonly unknown[];

// ── Descriptors (leaf → composite). Field order MUST match the explicit codec's wire output. ────────

const ELEMENT: Desc = [0, 'selector', S];
const RECT: Desc = [8, 'x', F, 'y', F, 'width', F, 'height', F, 'top', F, 'right', F, 'bottom', F, 'left', F];
const SERVER_TIMING: Desc = [1, 'name', S, 'duration', D, 'description', S];
const PAINT_TIME: Desc = [1, 'startTime', R, 'paintTime', R, 'presentationTime', R];
const LCP_ENTRY: Desc = [2, 'startTime', R, 'size', U, 'renderTime', R, 'loadTime', R, 'paintTime', R, 'presentationTime', R, 'id', S, 'url', S, 'element', ELEMENT];
const SHIFT_SOURCE: Desc = [0, 'node', ELEMENT, 'previousRect', RECT, 'currentRect', RECT];
const LAYOUT_SHIFT: Desc = [3, 'startTime', R, 'value', F, 'hadRecentInput', B, 'lastInputTime', R, 'sources', [SHIFT_SOURCE]];
const ELEMENT_TIMING: Desc = [1, 'startTime', R, 'identifier', S, 'url', S, 'renderTime', R, 'loadTime', R, 'naturalWidth', U, 'naturalHeight', U, 'element', ELEMENT];
const INTERACTION: Desc = [3, 'name', S, 'startTime', R, 'duration', D, 'processingStart', R, 'processingEnd', R, 'interactionId', U, 'cancelable', B, 'firstInput', B, 'target', ELEMENT];
const LONGTASK_ATTR: Desc = [0, 'name', S, 'containerType', S, 'containerName', S, 'containerId', S, 'containerSrc', S];
const LONGTASK: Desc = [2, 'startTime', R, 'duration', D, 'attribution', [LONGTASK_ATTR]];
const LOAF_SCRIPT: Desc = [2, 'startTime', R, 'duration', D, 'invokerType', S, 'invoker', S, 'executionStart', R, 'forcedStyleAndLayoutDuration', D, 'pauseDuration', D, 'sourceURL', S, 'sourceFunctionName', S, 'sourceCharPosition', U, 'windowAttribution', S];
const LOAF_FRAME: Desc = [2, 'startTime', R, 'duration', D, 'renderStart', R, 'styleAndLayoutStart', R, 'firstUIEventTimestamp', R, 'blockingDuration', D, 'paintTime', R, 'presentationTime', R, 'scripts', [LOAF_SCRIPT]];
const MARK: Desc = [2, 'name', S, 'startTime', R, 'detail', J];
const MEASURE: Desc = [3, 'name', S, 'startTime', R, 'duration', D, 'detail', J];
const VIS_STATE: Desc = [2, 'state', S, 'startTime', R];
const ERROR_ENTRY: Desc = [2, 'startTime', R, 'kind', S, 'name', S, 'message', S, 'source', S, 'lineno', U, 'colno', U, 'stack', S];
const UA_BRAND: Desc = [2, 'brand', S, 'version', S];
const UA_DATA: Desc = [0, 'brands', [UA_BRAND], 'mobile', B, 'platform', S, 'platformVersion', S, 'architecture', S, 'bitness', S, 'model', S, 'fullVersionList', [UA_BRAND], 'formFactors', SA];
const CONNECTION: Desc = [0, 'effectiveType', S, 'rtt', U, 'downlink', F, 'saveData', B];
const PROFILE_FRAME: Desc = [1, 'name', S, 'resourceId', U, 'line', U, 'column', U];
const CONTEXT_CLOCK: Desc = [4, 'id', S, 'kind', S, 'timeOrigin', F, 'offsetToPage', D];
const LOSS_NOTE: Desc = [1, 'kind', S, 'at', R, 'droppedCount', U, 'note', S];
const PROVENANCE: Desc = [0, 'api', S, 'browser', S, 'engine', S];
const STREAM_MANIFEST: Desc = [2, 'status', S, 'schemaVersion', U, 'loss', [LOSS_NOTE], 'provenance', PROVENANCE];
const STREAM_CONFIG: Desc = [0, 'enabled', B, 'sampleRate', F];
const PROFILER_CONFIG: Desc = [0, 'enabled', B, 'sampleIntervalMs', D, 'maxBufferSize', U, 'trigger', S];
const BUDGETS: Desc = [0, 'maxBytes', U, 'maxMainThreadMs', F, 'maxResourceEntries', U];
const SAMPLING: Desc = [0, 'sessionSampleRate', F];
const REDACTION: Desc = [0, 'urls', S, 'selectors', S];
const CONFIDENCE: Desc = [0, 'value', S, 'randomizedTriggerRate', F];
const OVERHEAD_ENTRY: Desc = [0, 'mainThreadMs', D, 'approxBytes', U];

// ResourceTiming: 4 required, then 28 optionals (exact order from the explicit codec).
const RESOURCE: Desc = [
  4, 'name', S, 'startTime', R, 'duration', D, 'initiatorType', S,
  'deliveryType', S, 'nextHopProtocol', S, 'renderBlockingStatus', S, 'contentType', S, 'contentEncoding', S,
  'workerStart', R, 'workerRouterEvaluationStart', R, 'workerCacheLookupStart', R, 'workerMatchedRouterSource', S, 'workerFinalRouterSource', S,
  'redirectStart', R, 'redirectEnd', R, 'fetchStart', R, 'domainLookupStart', R, 'domainLookupEnd', R,
  'connectStart', R, 'secureConnectionStart', R, 'connectEnd', R, 'requestStart', R,
  'firstInterimResponseStart', R, 'finalResponseHeadersStart', R, 'responseStart', R, 'responseEnd', R,
  'transferSize', U, 'encodedBodySize', U, 'decodedBodySize', U, 'responseStatus', U, 'serverTiming', [SERVER_TIMING],
];
// Navigation EXTRA fields, written after the resource block (notRestoredReasons is null-discriminated).
const NAV_EXTRA: Desc = [
  2, 'type', S, 'redirectCount', U,
  'unloadEventStart', R, 'unloadEventEnd', R, 'domInteractive', R, 'domContentLoadedEventStart', R, 'domContentLoadedEventEnd', R,
  'domComplete', R, 'loadEventStart', R, 'loadEventEnd', R, 'activationStart', R, 'criticalCHRestart', R,
  'notRestoredReasons', NRR, 'confidence', CONFIDENCE,
];

const CLOCK: Desc = [5, 'timeOrigin', F, 'captureStart', R, 'captureEnd', R, 'unit', S, 'base', S, 'precision', F, 'contexts', [CONTEXT_CLOCK]];
const CONFIG: Desc = [1, 'version', U, 'streams', SMAP, 'profiler', PROFILER_CONFIG, 'budgets', BUDGETS, 'sampling', SAMPLING, 'redaction', REDACTION];
const OVERHEAD: Desc = [0, 'mainThreadMs', D, 'approxBytes', U, 'byStream', OMAP, 'truncated', B];

// Per-stream payload types. navigation is the one struct with extra (resource+nav) framing → special.
const STREAM_T: Partial<Record<StreamId, unknown>> = {
  resources: [RESOURCE],
  paint: [0, 'firstPaint', PAINT_TIME, 'firstContentfulPaint', PAINT_TIME],
  lcp: [0, 'final', LCP_ENTRY, 'candidates', [LCP_ENTRY]],
  cls: [1, 'shifts', [LAYOUT_SHIFT]],
  interactions: [1, 'events', [INTERACTION]],
  longTasks: [1, 'tasks', [LONGTASK]],
  loaf: [1, 'frames', [LOAF_FRAME]],
  elementTiming: [1, 'elements', [ELEMENT_TIMING]],
  userTiming: [2, 'marks', [MARK], 'measures', [MEASURE]],
  visibility: [1, 'states', [VIS_STATE]],
  environment: [0, 'userAgent', S, 'userAgentData', UA_DATA, 'deviceMemory', F, 'hardwareConcurrency', U, 'connection', CONNECTION, 'viewportWidth', U, 'viewportHeight', U, 'screenWidth', U, 'screenHeight', U, 'devicePixelRatio', F, 'selfProfiler', S],
  profile: [4, 'frames', [PROFILE_FRAME], 'resources', SA, 'slices', PSLICES, 'droppedSamples', U, 'sampleIntervalMs', D],
  errors: [1, 'errors', [ERROR_ENTRY]],
};

// ── Generic walker ──────────────────────────────────────────────────────────────────────────────────

/** An unknown type code/tag means a descriptor bug or a future tag this build can't write — fail loud
 *  rather than fall through to a plausible-but-wrong encoder (the silent-corruption trap). */
function bad(t: unknown): never {
  throw new Error('bad descriptor type ' + String(t));
}

function field(e: Encoder, v: unknown, t: unknown): void {
  if (typeof t === 'number') {
    if (t === S) e.str(v as string);
    else if (t === R) e.rel(v as RelMs);
    else if (t === D) e.dur(v as DurationMs);
    else if (t === U) e.varuint(v as number);
    else if (t === F) e.f64(v as number);
    else if (t === B) e.bool(v as boolean);
    else if (t === J) encodeJson(e, v as JsonValue);
    else if (t === SA) e.strArray(v as string[]);
    else bad(t);
  } else if (typeof t === 'string') {
    if (t === NRR) encNullableNrr(e, v as NrrNode | null);
    else if (t === SMAP) encStreamMap(e, v as Record<string, unknown>, STREAM_CONFIG);
    else if (t === OMAP) encStreamMap(e, v as Record<string, unknown>, OVERHEAD_ENTRY);
    else if (t === PSLICES) encSlices(e, v as ReadonlyArray<{ frameId: number; depth: number; start: number; duration: number }>);
    else bad(t);
  } else if (typeof (t as Desc)[0] === 'number') {
    encStruct(e, v, t as Desc); // nested struct
  } else {
    const arr = v as unknown[];
    e.varuint(arr.length);
    const elem = (t as Desc)[0] as Desc;
    for (const x of arr) encStruct(e, x, elem); // array of struct
  }
}

function dfield(d: Decoder, t: unknown): unknown {
  if (typeof t === 'number') {
    if (t === S) return d.str();
    if (t === R) return d.rel();
    if (t === D) return d.dur();
    if (t === U) return d.varuint();
    if (t === F) return d.f64();
    if (t === B) return d.bool();
    if (t === J) return decodeJson(d);
    if (t === SA) return d.strArray();
    return bad(t);
  } else if (typeof t === 'string') {
    if (t === NRR) return decNullableNrr(d);
    if (t === SMAP) return decStreamMap(d, STREAM_CONFIG);
    if (t === OMAP) return decStreamMap(d, OVERHEAD_ENTRY);
    if (t === PSLICES) return decSlices(d);
    return bad(t);
  } else if (typeof (t as Desc)[0] === 'number') {
    return decStruct(d, t as Desc); // nested struct
  } else {
    const elem = (t as Desc)[0] as Desc;
    const n = d.varuint();
    const arr: unknown[] = new Array<unknown>(n);
    for (let i = 0; i < n; i++) arr[i] = decStruct(d, elem); // array of struct
    return arr;
  }
}

function encStruct(e: Encoder, o: unknown, desc: Desc): void {
  const obj = o as Record<string, unknown>;
  const rc = desc[0] as number;
  const m = (desc.length - 1) >> 1; // total field count
  for (let i = 0; i < rc; i++) {
    const k = desc[1 + 2 * i] as string;
    const v = obj[k];
    // A required field must be present; a missing one (bad descriptor key, or a malformed capture that
    // skipped the type system) would silently encode "undefined"/false/NaN and corrupt the wire.
    if (v === undefined) throw new Error('missing required field ' + k);
    field(e, v, desc[2 + 2 * i]);
  }
  const flags: boolean[] = [];
  for (let i = rc; i < m; i++) flags.push(obj[desc[1 + 2 * i] as string] !== undefined);
  e.presence(flags);
  for (let i = rc; i < m; i++) {
    if (flags[i - rc]) field(e, obj[desc[1 + 2 * i] as string], desc[2 + 2 * i]);
  }
}

function decStruct(d: Decoder, desc: Desc): Record<string, unknown> {
  const rc = desc[0] as number;
  const m = (desc.length - 1) >> 1;
  const o: Record<string, unknown> = {};
  for (let i = 0; i < rc; i++) o[desc[1 + 2 * i] as string] = dfield(d, desc[2 + 2 * i]);
  const flags = d.presence(m - rc);
  for (let i = rc; i < m; i++) {
    if (flags[i - rc]) o[desc[1 + 2 * i] as string] = dfield(d, desc[2 + 2 * i]);
  }
  return o;
}

// ── Special handlers (the shapes a flat descriptor can't express) ───────────────────────────────────

/** NotRestoredReasons tree — recursive, so it can't be a (TDZ-safe) self-referential descriptor. */
interface NrrNode {
  url?: string;
  src?: string;
  id?: string;
  name?: string;
  reasons?: Array<{ reason: string }>;
  children?: NrrNode[];
}
function encNrr(e: Encoder, n: NrrNode): void {
  e.presence([n.url !== undefined, n.src !== undefined, n.id !== undefined, n.name !== undefined, n.reasons !== undefined, n.children !== undefined]);
  if (n.url !== undefined) e.str(n.url);
  if (n.src !== undefined) e.str(n.src);
  if (n.id !== undefined) e.str(n.id);
  if (n.name !== undefined) e.str(n.name);
  if (n.reasons !== undefined) {
    e.varuint(n.reasons.length);
    for (const r of n.reasons) e.str(r.reason);
  }
  if (n.children !== undefined) {
    e.varuint(n.children.length);
    for (const c of n.children) encNrr(e, c);
  }
}
function decNrr(d: Decoder): NrrNode {
  const p = d.presence(6);
  const n: NrrNode = {};
  if (p[0]) n.url = d.str();
  if (p[1]) n.src = d.str();
  if (p[2]) n.id = d.str();
  if (p[3]) n.name = d.str();
  if (p[4]) {
    const c = d.varuint();
    const a: Array<{ reason: string }> = new Array<{ reason: string }>(c);
    for (let i = 0; i < c; i++) a[i] = { reason: d.str() };
    n.reasons = a;
  }
  if (p[5]) {
    const c = d.varuint();
    const a: NrrNode[] = new Array<NrrNode>(c);
    for (let i = 0; i < c; i++) a[i] = decNrr(d);
    n.children = a;
  }
  return n;
}
/** A `T | null` field: a 1-byte discriminator after its presence bit keeps absent / null / tree distinct. */
function encNullableNrr(e: Encoder, n: NrrNode | null): void {
  if (n === null) {
    e.u8(0);
  } else {
    e.u8(1);
    encNrr(e, n);
  }
}
function decNullableNrr(d: Decoder): NrrNode | null {
  return d.u8() === 0 ? null : decNrr(d);
}

/** A partial `Record<StreamId, V>` map: count + [streamIndex, V] pairs (V is a struct descriptor). */
function encStreamMap(e: Encoder, map: Record<string, unknown>, valueDesc: Desc): void {
  const ids = STREAM_IDS.filter((id) => map[id] !== undefined);
  e.varuint(ids.length);
  for (const id of ids) {
    e.u8(STREAM_INDEX[id]);
    encStruct(e, map[id], valueDesc);
  }
}
function decStreamMap(d: Decoder, valueDesc: Desc): Record<string, unknown> {
  const n = d.varuint();
  const map: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const idx = d.u8();
    const id = STREAM_IDS[idx];
    const v = decStruct(d, valueDesc); // decode even if id is unknown, to advance the cursor
    if (id !== undefined) map[id] = v;
  }
  return map;
}

/**
 * Profile slices — columnar. Four contiguous columns so gzip models each separately:
 *   frameId  — index into `frames` (raw varint).
 *   depth    — zigzag delta from the previous slice (pre-order depths move ±1 most of the time, so
 *              the deltas are tiny and very gzip-friendly — far smaller than raw depths up to 255).
 *   start    — first absolute µs tick, then non-negative µs deltas (pre-order ⇒ non-decreasing).
 *   duration — **1ms units**, not µs: slice durations are sample-INFERRED, accurate only to ±1 interval
 *              (~10ms), so storing microseconds would be false precision (and ~3 bytes/slice → ~1).
 * Nesting is implicit from depth + pre-order, so the per-sample form's interned `stacks` table is gone
 * entirely — far smaller on deep-stack pages.
 */
function encSlices(e: Encoder, slices: ReadonlyArray<{ frameId: number; depth: number; start: number; duration: number }>): void {
  e.varuint(slices.length);
  if (slices.length === 0) return;
  for (const s of slices) e.varuint(s.frameId);
  let prevDepth = 0;
  for (const s of slices) {
    const dd = s.depth - prevDepth;
    e.varuint(dd >= 0 ? dd * 2 : -dd * 2 - 1); // zigzag: maps small ± deltas onto small varints
    prevDepth = s.depth;
  }
  let prevTick = 0;
  for (let i = 0; i < slices.length; i++) {
    const tick = Math.round(slices[i]!.start * 1000);
    e.varuint(i === 0 ? tick : tick - prevTick); // pre-order ⇒ non-decreasing ⇒ delta ≥ 0
    prevTick = tick;
  }
  for (const s of slices) e.varuint(Math.round(s.duration)); // 1ms grid (durations are inferred ±1 interval)
}
function decSlices(d: Decoder): Array<{ frameId: number; depth: number; start: number; duration: number }> {
  const n = d.varuint();
  const out = new Array<{ frameId: number; depth: number; start: number; duration: number }>(n);
  if (n === 0) return out;
  const frameId = new Array<number>(n);
  const depth = new Array<number>(n);
  const start = new Array<number>(n);
  const duration = new Array<number>(n);
  for (let i = 0; i < n; i++) frameId[i] = d.varuint();
  let prevDepth = 0;
  for (let i = 0; i < n; i++) {
    const z = d.varuint();
    prevDepth += z % 2 === 0 ? z / 2 : -(z + 1) / 2; // un-zigzag, then accumulate
    depth[i] = prevDepth;
  }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = i === 0 ? d.varuint() : acc + d.varuint();
    start[i] = acc;
  }
  for (let i = 0; i < n; i++) duration[i] = d.varuint();
  for (let i = 0; i < n; i++) {
    out[i] = { frameId: frameId[i]!, depth: depth[i]!, start: start[i]! / 1000, duration: duration[i]! }; // start µs→ms; duration already ms
  }
  return out;
}

// ── Public entry points (consumed by pack.ts) ───────────────────────────────────────────────────────

/** Manifest: clock + the TOTAL per-stream record (14 entries, keys implied by position) + config. */
export function encodeManifest(e: Encoder, m: Manifest): void {
  encStruct(e, m.clock, CLOCK);
  for (const id of STREAM_IDS) encStruct(e, m.streams[id], STREAM_MANIFEST);
  encStruct(e, m.config, CONFIG);
}
export function decodeManifest(d: Decoder): Manifest {
  const clock = decStruct(d, CLOCK);
  const streams: Record<string, unknown> = {};
  for (const id of STREAM_IDS) streams[id] = decStruct(d, STREAM_MANIFEST);
  const config = decStruct(d, CONFIG);
  return { clock, streams, config } as unknown as Manifest;
}

export function encodeOverhead(e: Encoder, o: OverheadReport): void {
  encStruct(e, o, OVERHEAD);
}
export function decodeOverhead(d: Decoder): OverheadReport {
  return decStruct(d, OVERHEAD) as unknown as OverheadReport;
}

/** Encode one stream's payload. navigation is the single special case (resource block + nav block). */
export function encodeStream(e: Encoder, id: StreamId, data: unknown): void {
  if (id === 'navigation') {
    encStruct(e, data, RESOURCE);
    encStruct(e, data, NAV_EXTRA);
  } else {
    field(e, data, STREAM_T[id]);
  }
}
export function decodeStream(d: Decoder, id: StreamId): unknown {
  if (id === 'navigation') {
    const base = decStruct(d, RESOURCE);
    return Object.assign(base, decStruct(d, NAV_EXTRA));
  }
  return dfield(d, STREAM_T[id]);
}
