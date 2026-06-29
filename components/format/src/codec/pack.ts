/**
 * The codec entry points: `pack(Capture) -> bytes` and `unpack(bytes) -> Capture`, plus the file's
 * cleartext header and the gzip wrapper.
 *
 * Wire layout:
 *
 *   [ magic: F5 52 55 4D ]            cleartext — \xF5 is never a valid UTF-8 lead byte, so the file
 *   [ codecVersion: varuint ]         is unambiguously binary and sniffable by these bytes alone
 *   [ formatVersion: varuint ]        (the schema/model version carried by Capture.formatVersion)
 *   [ gzip( body ) ]                  everything below is gzipped as one stream
 *       body = a sequence of length-prefixed, tagged sections:
 *         [ tag: u8 ][ byteLength: varuint ][ payload ]
 *       section tags:
 *         1 STRING_TABLE   the interned strings — emitted FIRST so ids resolve before use
 *         2 MANIFEST       clock + per-stream status/loss/provenance + capture-config
 *         3 STREAM         [ streamIndex: u8 ][ stream data ] — one per present stream
 *         4 OVERHEAD       capture's self-measured cost
 *
 * Each section is independently length-bounded, so an unknown tag or a future stream index is simply
 * skipped — an older reader never breaks on a newer file (the "skippable blocks" guarantee). The
 * magic/version live OUTSIDE the gzip so a consumer can identify and version-check the file without
 * decompressing.
 *
 * `pack` is async only because gzip (`CompressionStream`) is; the structural encode itself is
 * synchronous and per-section, which is the seam a future on-page driver uses to prepare stream bytes
 * incrementally and flush only the (cheap) string table at pagehide — never a big synchronous
 * pack+compress on the unload path (AGENTS "no unload serialization cliff"). It is also the boundary a
 * WASM implementation of the structural codec would slot into without changing this API.
 */

import type { Capture } from '../capture.js';
import type { OverheadReport } from '../capture.js';
import type { Manifest } from '../manifest.js';
import type { Streams } from '../streams/index.js';
import { STREAM_IDS, type StreamId } from '../registry.js';
import { Encoder, Decoder, Reader, Writer, StringTable } from './io.js';
import {
  STREAM_INDEX,
  encodeManifest,
  decodeManifest,
  encodeOverhead,
  decodeOverhead,
  encodeStream,
  decodeStream,
} from './schema.js';

/** File signature: `\xF5RUM`. `0xF5` is an always-invalid UTF-8 lead byte → unmistakably binary. */
export const MAGIC: Readonly<Uint8Array> = new Uint8Array([0xf5, 0x52, 0x55, 0x4d]);

/** Wire/codec version, independent of the schema `FORMAT_VERSION`. Bumped only on a wire-layout change. */
export const CODEC_VERSION = 1;

/** Canonical file extension for a packed capture. */
export const FILE_EXTENSION = '.rcap';

const SECTION_STRING_TABLE = 1;
const SECTION_MANIFEST = 2;
const SECTION_STREAM = 3;
const SECTION_OVERHEAD = 4;

interface Section {
  tag: number;
  bytes: Uint8Array;
}

function writeSection(w: Writer, tag: number, payload: Uint8Array): void {
  w.u8(tag);
  w.varuint(payload.length);
  w.bytes(payload);
}

/**
 * Emit one STREAM section per present stream, driven by the descriptor table in schema.ts. Only
 * present streams produce a section — an absent stream costs nothing; its status lives in the
 * manifest. (`Streams` keys ARE the StreamIds, so iterating STREAM_IDS covers them exactly.)
 */
function encodeStreamSections(strings: StringTable, s: Streams, out: Section[]): void {
  for (const id of STREAM_IDS) {
    const data = s[id];
    if (data === undefined) continue;
    const e = new Encoder(strings);
    e.u8(STREAM_INDEX[id]);
    encodeStream(e, id, data);
    out.push({ tag: SECTION_STREAM, bytes: e.w.finish() });
  }
}

function decodeStreamInto(d: Decoder, streams: Streams): void {
  const idx = d.u8();
  const id = STREAM_IDS[idx];
  // unknown/future stream index → id is undefined; the section is length-bounded, so skipping is safe.
  if (id !== undefined) (streams as Record<StreamId, unknown>)[id] = decodeStream(d, id);
}

// ── gzip wrapper (CompressionStream is a Web API present in browsers and Node 18+) ─────────────────

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Run `input` through a (de)compression transform. We drain the readable concurrently with writing so
 * the transform never stalls on backpressure, then close the writer to flush. (The writer/reader form
 * avoids `pipeThrough`'s strict chunk-type inference, which rejects `WritableStream<BufferSource>`.)
 */
async function pump(
  input: Uint8Array,
  ts: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
): Promise<Uint8Array> {
  const writer = ts.writable.getWriter();
  const readPromise = collect(ts.readable);
  const writePromise = (async () => {
    // Our buffers are always ArrayBuffer-backed (we never allocate SharedArrayBuffer); the generic
    // `Uint8Array<ArrayBufferLike>` default can't prove that to the BufferSource bound, so assert it.
    await writer.write(input as unknown as BufferSource);
    await writer.close();
  })();
  // Await BOTH sides together. On a decode error (e.g. invalid gzip) both reject; `Promise.all`
  // attaches a handler to each, so neither is left as an unhandled rejection that Node would surface
  // as a stray stream error after the caller has already handled the failure.
  const [, out] = await Promise.all([writePromise, readPromise]);
  return out;
}

const gzip = (bytes: Uint8Array): Promise<Uint8Array> => pump(bytes, new CompressionStream('gzip'));
const gunzip = (bytes: Uint8Array): Promise<Uint8Array> => pump(bytes, new DecompressionStream('gzip'));

// ── Public API ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Pack a capture into the compact, gzipped `.rcap` byte stream. Lossless to 1µs on timeline values
 * (`RelMs`/`DurationMs` are quantized to the microsecond grid — below the browser's ≤5µs real
 * resolution) and exact on every other field; `unpack(pack(c))` deep-equals `c` for any capture whose
 * timestamps are already at ≤1µs resolution (everything a browser produces).
 */
export async function pack(capture: Capture): Promise<Uint8Array> {
  const strings = new StringTable();
  const sections: Section[] = [];

  const manifestEnc = new Encoder(strings);
  encodeManifest(manifestEnc, capture.manifest);
  sections.push({ tag: SECTION_MANIFEST, bytes: manifestEnc.w.finish() });

  encodeStreamSections(strings, capture.streams, sections);

  if (capture.overhead !== undefined) {
    const overheadEnc = new Encoder(strings);
    encodeOverhead(overheadEnc, capture.overhead);
    sections.push({ tag: SECTION_OVERHEAD, bytes: overheadEnc.w.finish() });
  }

  // The table is complete only now that every section has interned its strings; serialize it and
  // place it first so the reader resolves ids before any section that references them.
  const tableW = new Writer();
  strings.encode(tableW);

  const body = new Writer();
  writeSection(body, SECTION_STRING_TABLE, tableW.finish());
  for (const s of sections) writeSection(body, s.tag, s.bytes);

  const compressed = await gzip(body.finish());

  const out = new Writer();
  out.bytes(MAGIC);
  out.varuint(CODEC_VERSION);
  out.varuint(capture.formatVersion);
  out.bytes(compressed);
  return out.finish();
}

/** Unpack a `.rcap` byte stream back into the in-memory capture model. */
export async function unpack(input: Uint8Array | ArrayBuffer): Promise<Capture> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const head = new Reader(bytes);
  for (let i = 0; i < MAGIC.length; i++) {
    if (head.u8() !== MAGIC[i]) throw new Error('not a .rcap capture (bad magic bytes)');
  }
  const codecVersion = head.varuint();
  if (codecVersion !== CODEC_VERSION) {
    throw new Error(`unsupported .rcap codec version ${codecVersion} (this build reads ${CODEC_VERSION})`);
  }
  const formatVersion = head.varuint();

  const payload = await gunzip(bytes.subarray(head.pos));
  const r = new Reader(payload);

  let strings: readonly string[] | undefined;
  let manifest: Manifest | undefined;
  let overhead: OverheadReport | undefined;
  const streams: Streams = {};

  while (!r.atEnd) {
    const tag = r.u8();
    const len = r.varuint();
    const sectionBytes = r.bytes(len);
    if (tag === SECTION_STRING_TABLE) {
      strings = StringTable.decode(new Reader(sectionBytes));
      continue;
    }
    if (strings === undefined) {
      throw new Error('corrupt .rcap: string table must precede other sections');
    }
    const d = new Decoder(new Reader(sectionBytes), strings);
    switch (tag) {
      case SECTION_MANIFEST:
        manifest = decodeManifest(d);
        break;
      case SECTION_STREAM:
        decodeStreamInto(d, streams);
        break;
      case SECTION_OVERHEAD:
        overhead = decodeOverhead(d);
        break;
      default:
        break; // unknown section already consumed via its length prefix (forward-compat)
    }
  }

  if (manifest === undefined) throw new Error('corrupt .rcap: missing manifest section');
  const capture: Capture = { formatVersion, manifest, streams };
  if (overhead !== undefined) capture.overhead = overhead;
  return capture;
}
