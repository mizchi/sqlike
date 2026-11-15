import type { ImageDelta } from "../src/persistence-contract.ts";
interface PageBatch {
  format: "page-delta@1";
  pageSize: number;
  beforeBytes: number;
  afterBytes: number;
  pages: number[];
}
function validPageSize(size: number): void {
  if (
    !Number.isInteger(size) ||
    size < 512 ||
    size > 65536 ||
    size & (size - 1)
  )
    throw Error("invalid page size");
}
/** Full-buffer comparison is deliberately included: the current SQLike writer
 * rebuilds SQLite images, and has no pager providing a dirty-page bitmap. */
export function pageDelta(
  before: Uint8Array,
  after: Uint8Array,
  pageSize = 4096,
): ImageDelta {
  validPageSize(pageSize);
  if (after.byteLength > 64 * 1024 * 1024) throw Error("page image limit");
  const pages: number[] = [],
    blobs: Uint8Array[] = [];
  for (let offset = 0; offset < after.length; offset += pageSize) {
    const end = Math.min(after.length, offset + pageSize);
    let dirty = end > before.length;
    for (let i = offset; !dirty && i < end; i++)
      if (before[i] !== after[i]) dirty = true;
    if (dirty) {
      pages.push(offset / pageSize);
      blobs.push(after.slice(offset, end));
    }
  }
  const meta: PageBatch = {
    format: "page-delta@1",
    pageSize,
    beforeBytes: before.length,
    afterBytes: after.length,
    pages,
  };
  return { text: JSON.stringify(meta), blobs };
}
export function applyPageDelta(
  before: Uint8Array,
  delta: ImageDelta,
): Uint8Array {
  const meta = JSON.parse(delta.text) as PageBatch;
  validPageSize(meta.pageSize);
  if (
    meta.format !== "page-delta@1" ||
    meta.beforeBytes !== before.length ||
    !Number.isSafeInteger(meta.afterBytes) ||
    meta.afterBytes < 0 ||
    meta.afterBytes > 64 * 1024 * 1024 ||
    !Array.isArray(meta.pages) ||
    !Array.isArray(delta.blobs) ||
    meta.pages.length !== delta.blobs.length
  )
    throw Error("invalid page batch");
  const seen = new Set<number>();
  for (const [i, page] of meta.pages.entries()) {
    const blob = delta.blobs[i];
    if (
      !Number.isSafeInteger(page) ||
      page < 0 ||
      page * meta.pageSize >= meta.afterBytes ||
      seen.has(page) ||
      !(blob instanceof Uint8Array) ||
      blob.length !==
        Math.min(meta.pageSize, meta.afterBytes - page * meta.pageSize)
    )
      throw Error("invalid page record");
    seen.add(page);
  }
  // Newly grown bytes must be supplied, including a previously partial page.
  for (
    let offset = Math.floor(before.length / meta.pageSize) * meta.pageSize;
    offset < meta.afterBytes;
    offset += meta.pageSize
  ) {
    if (
      offset + meta.pageSize > before.length &&
      !seen.has(offset / meta.pageSize)
    )
      throw Error("missing grown page");
  }
  const after = new Uint8Array(meta.afterBytes);
  after.set(before.subarray(0, meta.afterBytes));
  for (const [i, page] of meta.pages.entries())
    after.set(delta.blobs[i]!, page * meta.pageSize);
  return after;
}
