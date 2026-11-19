import type { ImageCheckpoint } from "../src/persistence-contract.ts";
import { sha256 } from "../src/aot-values.ts";
const MAX_BYTES = 64 * 1024 * 1024;
export interface CheckpointRef {
  generation: number;
  index: number;
  bytes: number;
  sha256: string;
}
export interface CheckpointManifest {
  format: "moon-snapshot-parts@2";
  text: string;
  refs: CheckpointRef[];
  bytes: number;
  sha256: string;
}
export interface PreparedCheckpoint {
  manifest: CheckpointManifest;
  puts: { ref: CheckpointRef; data: Uint8Array }[];
  removes: CheckpointRef[];
  reset: boolean;
  base?: number;
}
export function partKey(
  ref: Pick<CheckpointRef, "generation" | "index">,
): [string, number, number] {
  return ["part", ref.generation, ref.index];
}
export function captureImageCheckpoint(
  value: ImageCheckpoint,
): ImageCheckpoint {
  if (
    !value ||
    typeof value.text !== "string" ||
    !Array.isArray(value.chunks) ||
    value.chunks.length > 100000 ||
    (value.base !== undefined &&
      (!Number.isSafeInteger(value.base) || value.base < 1))
  )
    throw Error("invalid Moon differential checkpoint");
  let bytes = new TextEncoder().encode(value.text).length;
  for (const c of value.chunks) {
    if (c instanceof Uint8Array) bytes += c.byteLength;
    else if (
      !Number.isInteger(c) ||
      c < 0 ||
      c >= 100000 ||
      value.base === undefined
    )
      throw Error("invalid Moon checkpoint reference");
  }
  if (bytes > MAX_BYTES) throw Error("Moon checkpoint exceeds 64 MiB");
  return {
    text: value.text,
    base: value.base,
    chunks: value.chunks.map((c) =>
      typeof c === "number" ? c : Uint8Array.from(c),
    ),
  };
}
function seal(m: Omit<CheckpointManifest, "sha256">) {
  return sha256(
    JSON.stringify({
      format: m.format,
      text: m.text,
      refs: m.refs,
      bytes: m.bytes,
    }),
  );
}
export function checkpointManifest(
  value: unknown,
  generation: number,
): CheckpointManifest {
  const m = value as CheckpointManifest;
  if (
    !m ||
    m.format !== "moon-snapshot-parts@2" ||
    typeof m.text !== "string" ||
    !Array.isArray(m.refs) ||
    m.refs.length > 100000 ||
    !Number.isSafeInteger(m.bytes) ||
    m.bytes < 0 ||
    m.bytes > MAX_BYTES ||
    !/^[0-9a-f]{64}$/.test(m.sha256)
  )
    throw Error("invalid Moon checkpoint manifest");
  let bytes = new TextEncoder().encode(m.text).length;
  const seen = new Set<string>();
  for (const r of m.refs) {
    if (
      !r ||
      !Number.isSafeInteger(r.generation) ||
      r.generation < 1 ||
      r.generation > generation ||
      !Number.isInteger(r.index) ||
      r.index < 0 ||
      r.index >= 100000 ||
      !Number.isSafeInteger(r.bytes) ||
      r.bytes < 0 ||
      r.bytes > MAX_BYTES ||
      !/^[0-9a-f]{64}$/.test(r.sha256) ||
      seen.has(JSON.stringify(partKey(r)))
    )
      throw Error("invalid Moon checkpoint manifest reference");
    seen.add(JSON.stringify(partKey(r)));
    bytes += r.bytes;
  }
  if (bytes !== m.bytes) throw Error("Moon checkpoint length mismatch");
  return m;
}
export async function verifyCheckpoint(
  m: CheckpointManifest,
  chunks?: Uint8Array[],
) {
  if ((await seal(m)) !== m.sha256)
    throw Error("Moon checkpoint manifest checksum mismatch");
  if (!chunks) return;
  if (chunks.length !== m.refs.length) throw Error("Moon checkpoint part gap");
  for (let start = 0; start < chunks.length; start += 128)
    await Promise.all(
      chunks.slice(start, start + 128).map(async (c, i) => {
        const ref = m.refs[start + i]!;
        if (
          !(c instanceof Uint8Array) ||
          c.byteLength !== ref.bytes ||
          (await sha256(c)) !== ref.sha256
        )
          throw Error("Moon checkpoint part checksum mismatch");
      }),
    );
}
export async function prepareImageCheckpoint(
  expected: number,
  value: ImageCheckpoint,
  previous?: CheckpointManifest,
  checkpoint?: number,
): Promise<PreparedCheckpoint> {
  if (previous) await verifyCheckpoint(previous);
  if (value.base !== undefined && (!previous || value.base !== checkpoint))
    throw Error("Moon checkpoint base changed; reload required");
  const puts: PreparedCheckpoint["puts"] = [],
    refs: CheckpointRef[] = [],
    seen = new Set<string>();
  let bytes = new TextEncoder().encode(value.text).length;
  const hashes = new Map<number, string>();
  for (let start = 0; start < value.chunks.length; start += 128) {
    await Promise.all(
      value.chunks.slice(start, start + 128).map(async (c, i) => {
        if (typeof c !== "number") hashes.set(start + i, await sha256(c));
      }),
    );
  }
  for (let i = 0; i < value.chunks.length; i++) {
    const c = value.chunks[i]!;
    const ref =
      typeof c === "number"
        ? previous?.refs[c]
        : {
            generation: expected + 1,
            index: i,
            bytes: c.byteLength,
            sha256: hashes.get(i)!,
          };
    if (!ref || seen.has(JSON.stringify(partKey(ref))))
      throw Error("invalid or duplicate Moon checkpoint reference");
    refs.push(ref);
    seen.add(JSON.stringify(partKey(ref)));
    bytes += ref.bytes;
    if (typeof c !== "number") puts.push({ ref, data: c });
  }
  if (bytes > MAX_BYTES) throw Error("Moon checkpoint exceeds 64 MiB");
  const manifest: CheckpointManifest = {
    format: "moon-snapshot-parts@2",
    text: value.text,
    refs,
    bytes,
    sha256: "",
  };
  manifest.sha256 = await seal(manifest);
  return {
    manifest,
    puts,
    removes: (previous?.refs ?? []).filter(
      (r) => !seen.has(JSON.stringify(partKey(r))),
    ),
    reset: !previous,
    base: value.base,
  };
}
