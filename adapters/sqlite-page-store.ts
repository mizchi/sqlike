import type {
  SqlitePageCommit,
  SqlitePageHead,
  SqlitePageStore,
} from "../src/sqlite-pager-contract.ts";
import { SQLITE_PAGE_FILE_LIMIT } from "../src/sqlite-pager-contract.ts";
import { sha256 } from "../src/aot-values.ts";

const fileName = (name: unknown): name is string =>
  typeof name === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(name);

function validateChecksumPages(pages: readonly number[], count: number) {
  if (!Array.isArray(pages) || pages.length > count)
    throw Error("invalid SQLite checksum request");
  let previous = 0;
  for (const page of pages) {
    if (!Number.isInteger(page) || page <= previous || page > count)
      throw Error("invalid SQLite checksum page range");
    previous = page;
  }
}

export function validatePageHead(value: unknown): SqlitePageHead | undefined {
  if (value === undefined) return;
  const h = value as SqlitePageHead;
  if (
    h.format !== "sqlike-pages@1" ||
    !Number.isSafeInteger(h.generation) ||
    h.generation < 1 ||
    !Number.isInteger(h.pageSize) ||
    h.pageSize < 512 ||
    h.pageSize > 65536 ||
    h.pageSize & (h.pageSize - 1) ||
    !Number.isInteger(h.pageCount) ||
    h.pageCount < 1 ||
    h.pageCount > 67108864 / h.pageSize ||
    !Number.isInteger(h.serial) ||
    h.serial < 0 ||
    h.serial > 2147483647 ||
    typeof h.programId !== "string" ||
    !h.programId.length ||
    h.programId.length > 256 ||
    (h.checksumFormat !== undefined && h.checksumFormat !== "crc64-be@1") ||
    (h.metadata !== undefined &&
      (typeof h.metadata !== "string" || h.metadata.length > 8388608)) ||
    (h.files !== undefined &&
      (!Array.isArray(h.files) ||
        h.files.length > SQLITE_PAGE_FILE_LIMIT ||
        h.files.some((n) => !fileName(n)) ||
        new Set(h.files).size !== h.files.length))
  )
    throw Error("invalid SQLite page head");
  return { ...h, ...(h.files ? { files: [...h.files] } : {}) };
}
/** Capture before the first await, so caller-owned arrays cannot change a commit. */
export function capturePageCommit(value: SqlitePageCommit): SqlitePageCommit {
  validatePageHead({
    ...value,
    files: undefined,
    format: "sqlike-pages@1",
    generation: 1,
  });
  if (typeof value.snapshot !== "boolean" || !Array.isArray(value.pages))
    throw Error("invalid SQLite page commit");
  let previous = 0;
  const pages = value.pages.map(({ page, data }) => {
    if (
      !Number.isInteger(page) ||
      page <= previous ||
      page > value.pageCount ||
      !(data instanceof Uint8Array) ||
      data.length !== value.pageSize
    )
      throw Error("invalid SQLite page record");
    previous = page;
    return { page, data: Uint8Array.from(data) };
  });
  if (
    value.snapshot &&
    (pages.length !== value.pageCount || pages.some((p, i) => p.page !== i + 1))
  )
    throw Error("incomplete SQLite page snapshot");
  if (
    value.files !== undefined &&
    (!Array.isArray(value.files) || value.files.length > SQLITE_PAGE_FILE_LIMIT)
  )
    throw Error("invalid SQLite attached files");
  const names = new Set<string>();
  const files = value.files?.map((f) => {
    if (
      !fileName(f.name) ||
      names.has(f.name) ||
      !(f.data instanceof Uint8Array) ||
      f.data.length > 67108864
    )
      throw Error("invalid SQLite attached file");
    names.add(f.name);
    return { name: f.name, data: Uint8Array.from(f.data) };
  });
  if (
    (value.checksumSnapshot !== undefined &&
      typeof value.checksumSnapshot !== "boolean") ||
    (value.checksums !== undefined &&
      (!Array.isArray(value.checksums) ||
        value.checksums.length > value.pageCount))
  )
    throw Error("invalid SQLite checksums");
  let previousChecksum = 0;
  const checksums = value.checksums?.map((c) => {
    if (
      !Number.isInteger(c.page) ||
      c.page <= previousChecksum ||
      c.page > value.pageCount ||
      !(c.data instanceof Uint8Array) ||
      c.data.length !== 8
    )
      throw Error("invalid SQLite checksum record");
    previousChecksum = c.page;
    return { page: c.page, data: Uint8Array.from(c.data) };
  });
  if (
    value.removeFiles !== undefined &&
    (!Array.isArray(value.removeFiles) ||
      value.removeFiles.length > SQLITE_PAGE_FILE_LIMIT ||
      value.removeFiles.some((n) => !fileName(n)))
  )
    throw Error("invalid SQLite removed files");
  return {
    ...value,
    pages,
    ...(files ? { files } : {}),
    ...(value.removeFiles ? { removeFiles: [...value.removeFiles] } : {}),
    ...(checksums ? { checksums } : {}),
  };
}
export function nextPageHead(
  expected: number,
  before: SqlitePageHead | undefined,
  value: SqlitePageCommit,
): SqlitePageHead {
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    expected >= Number.MAX_SAFE_INTEGER ||
    (before?.generation ?? 0) !== expected
  )
    throw Error("stale SQLite page generation");
  if (!value.snapshot) {
    if (
      !before ||
      before.programId !== value.programId ||
      before.pageSize !== value.pageSize ||
      value.serial < before.serial
    )
      throw Error("SQLite page delta needs a snapshot");
    const pages = new Set(value.pages.map((p) => p.page));
    for (let p = before.pageCount + 1; p <= value.pageCount; p++)
      if (!pages.has(p)) throw Error("missing grown SQLite page");
    if (value.pageCount !== before.pageCount && !pages.has(1))
      throw Error("missing SQLite header page");
  }
  const files = new Set(before?.files ?? []);
  const checksumFormat = value.checksumFormat ?? before?.checksumFormat;
  if (checksumFormat) {
    if ((!before?.checksumFormat || value.snapshot) && !value.checksumSnapshot)
      throw Error("SQLite checksum snapshot required");
    if (value.checksumSnapshot) {
      if (
        value.checksums?.length !== value.pageCount ||
        value.checksums.some((c, i) => c.page !== i + 1)
      )
        throw Error("incomplete SQLite checksum snapshot");
    } else if (value.pages.length || value.checksums?.length) {
      if (
        value.checksums?.length !== value.pages.length ||
        value.checksums.some((c, i) => c.page !== value.pages[i]!.page)
      )
        throw Error("SQLite checksum updates do not match pages");
    }
  } else if (value.checksumSnapshot || value.checksums !== undefined)
    throw Error("missing SQLite checksum format");
  for (const name of value.removeFiles ?? []) files.delete(name);
  for (const f of value.files ?? []) {
    if (files.has(f.name)) throw Error("duplicate SQLite attached file");
    files.add(f.name);
  }
  if (files.size > SQLITE_PAGE_FILE_LIMIT)
    throw Error("SQLite attached file limit");
  if (
    before?.metadata !== undefined &&
    value.metadata === undefined &&
    value.pages.length
  )
    throw Error("SQLite page metadata update required");
  return {
    format: "sqlike-pages@1",
    generation: expected + 1,
    programId: value.programId,
    pageSize: value.pageSize,
    pageCount: value.pageCount,
    serial: value.serial,
    ...(checksumFormat ? { checksumFormat } : {}),
    ...(value.metadata !== undefined || before?.metadata !== undefined
      ? { metadata: value.metadata ?? before!.metadata }
      : {}),
    ...(files.size || before?.files ? { files: [...files].sort() } : {}),
  };
}
interface MemoryPages {
  head?: SqlitePageHead;
  pages: Map<number, Uint8Array>;
  files?: Map<string, Uint8Array>;
  checksums?: Map<number, Uint8Array>;
}
export class MemorySqlitePageStore implements SqlitePageStore {
  private closed = false;
  constructor(private state: MemoryPages = { pages: new Map() }) {}
  fork() {
    return new MemorySqlitePageStore(this.state);
  }
  private healthy() {
    if (this.closed) throw Error("SQLite page store is closed");
  }
  async head() {
    this.healthy();
    return validatePageHead(this.state.head);
  }
  async readPage(generation: number, page: number) {
    this.healthy();
    if (this.state.head?.generation !== generation)
      throw Error("stale SQLite page generation");
    const bytes = this.state.pages.get(page);
    if (!bytes) throw Error("missing SQLite page");
    return bytes.slice();
  }
  async commit(expected: number, value: SqlitePageCommit) {
    this.healthy();
    const captured = capturePageCommit(value);
    const head = nextPageHead(expected, this.state.head, captured);
    const pages = captured.snapshot
      ? new Map<number, Uint8Array>()
      : new Map(this.state.pages);
    for (const p of captured.pages) pages.set(p.page, p.data);
    for (const p of pages.keys()) if (p > head.pageCount) pages.delete(p);
    const files = new Map(this.state.files);
    for (const name of captured.removeFiles ?? []) files.delete(name);
    for (const file of captured.files ?? []) files.set(file.name, file.data);
    const checksums = captured.checksumSnapshot
      ? new Map<number, Uint8Array>()
      : new Map(this.state.checksums);
    for (const c of captured.checksums ?? []) checksums.set(c.page, c.data);
    for (const p of checksums.keys())
      if (p > head.pageCount) checksums.delete(p);
    this.state.pages = pages;
    this.state.files = files;
    this.state.checksums = checksums;
    this.state.head = head;
    return validatePageHead(head)!;
  }
  async readFile(generation: number, name: string) {
    this.healthy();
    if (this.state.head?.generation !== generation)
      throw Error("stale SQLite page generation");
    const bytes = this.state.files?.get(name);
    if (!bytes) throw Error("missing SQLite attached file");
    return bytes.slice();
  }
  async readChecksums(generation: number, pages: readonly number[]) {
    this.healthy();
    if (this.state.head?.generation !== generation)
      throw Error("stale SQLite checksum generation");
    const head = this.state.head;
    if (!head.checksumFormat) throw Error("missing SQLite checksum catalog");
    validateChecksumPages(pages, head.pageCount);
    const data = new Uint8Array(pages.length * 8);
    pages.forEach((page, i) => {
      const crc = this.state.checksums?.get(page);
      if (!crc || crc.length !== 8) throw Error("missing SQLite page checksum");
      data.set(crc, i * 8);
    });
    return data;
  }
  close() {
    this.closed = true;
  }
}

interface DiskPage {
  data: ArrayBuffer;
  sha256: string;
}
export interface SqlitePageTransaction {
  stores: string[];
  apply(tx: IDBTransaction, fail: (error: unknown) => void): void;
  head(): SqlitePageHead;
}
export class IndexedDbSqlitePageStore implements SqlitePageStore {
  readonly readChecksums?: (
    generation: number,
    pages: readonly number[],
  ) => Promise<Uint8Array>;
  private constructor(
    private db: IDBDatabase,
    private names = {
      head: "head",
      pages: "pages",
      files: "files",
      checksums: "checksums",
    },
    private ownsDatabase = true,
  ) {
    if (db.objectStoreNames.contains(names.checksums))
      this.readChecksums = (generation, pages) =>
        this.readChecksumRecords(generation, pages);
  }
  /** Share one database/transaction with an opaque logical journal. */
  static attach(
    db: IDBDatabase,
    names: { head: string; pages: string; files: string; checksums?: string },
  ) {
    return new IndexedDbSqlitePageStore(
      db,
      { ...names, checksums: names.checksums ?? names.pages + "-checksums" },
      false,
    );
  }
  static open(name: string): Promise<IndexedDbSqlitePageStore> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
      return Promise.reject(Error("invalid SQLite page store name"));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("sqlike-pages-" + name, 3);
      let blocked = false;
      request.onupgradeneeded = () => {
        for (const store of ["head", "pages", "files", "checksums"])
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(Error("SQLite page store upgrade blocked"));
      };
      request.onsuccess = () => {
        if (blocked) request.result.close();
        else resolve(new IndexedDbSqlitePageStore(request.result));
      };
    });
  }
  async head(): Promise<SqlitePageHead | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.names.head, "readonly"),
        request = tx.objectStore(this.names.head).get(0);
      let head: SqlitePageHead | undefined;
      request.onsuccess = () => {
        try {
          head = validatePageHead(request.result);
        } catch (e) {
          reject(e);
          try {
            tx.abort();
          } catch {}
        }
      };
      tx.oncomplete = () => resolve(head);
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? Error("SQLite page head read failed"));
    });
  }
  private async readRecord(
    generation: number,
    key: IDBValidKey,
    name: "pages" | "files",
  ): Promise<Uint8Array> {
    const record = await new Promise<DiskPage>((resolve, reject) => {
      const tx = this.db.transaction(
          [this.names.head, this.names[name]],
          "readonly",
        ),
        head = tx.objectStore(this.names.head).get(0),
        entry = tx.objectStore(this.names[name]).get(key);
      tx.oncomplete = () => {
        try {
          const current = validatePageHead(head.result);
          if (current?.generation !== generation)
            throw Error("stale SQLite page generation");
          const r = entry.result as DiskPage;
          if (
            !r ||
            !(r.data instanceof ArrayBuffer) ||
            typeof r.sha256 !== "string"
          )
            throw Error("missing SQLite page");
          if (
            name === "pages" &&
            (!Number.isInteger(key) ||
              Number(key) < 1 ||
              Number(key) > current.pageCount ||
              r.data.byteLength !== current.pageSize)
          )
            throw Error("invalid SQLite page record size/range");
          if (name === "files" && !current.files?.includes(String(key)))
            throw Error("missing SQLite attached file");
          resolve(r);
        } catch (e) {
          reject(e);
        }
      };
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? Error("SQLite page read failed"));
    });
    const data = new Uint8Array(record.data);
    if ((await sha256(data)) !== record.sha256)
      throw Error("SQLite page checksum mismatch");
    return data;
  }
  readPage(generation: number, page: number) {
    return this.readRecord(generation, page, "pages");
  }
  readFile(generation: number, name: string) {
    return this.readRecord(generation, name, "files");
  }
  private async readChecksumRecords(
    generation: number,
    pages: readonly number[],
  ) {
    const requested = [...pages];
    // Bound allocations even before the persisted head is available.
    validateChecksumPages(requested, 131072);
    const records = await new Promise<DiskPage[]>((resolve, reject) => {
      const tx = this.db.transaction(
        [this.names.head, this.names.checksums],
        "readonly",
      );
      const root = tx.objectStore(this.names.head).get(0);
      const entries = requested.map((page) =>
        tx.objectStore(this.names.checksums).get(page),
      );
      tx.oncomplete = () => {
        try {
          const head = validatePageHead(root.result);
          if (!head || head.generation !== generation)
            throw Error("stale SQLite checksum generation");
          if (!head.checksumFormat)
            throw Error("missing SQLite checksum catalog");
          validateChecksumPages(requested, head.pageCount);
          resolve(
            entries.map((e) => {
              const r = e.result as DiskPage;
              if (
                !r ||
                !(r.data instanceof ArrayBuffer) ||
                r.data.byteLength !== 8 ||
                typeof r.sha256 !== "string"
              )
                throw Error("missing SQLite page checksum");
              return r;
            }),
          );
        } catch (e) {
          reject(e);
        }
      };
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? Error("SQLite checksum read failed"));
    });
    const output = new Uint8Array(requested.length * 8);
    for (let start = 0; start < records.length; start += 16)
      await Promise.all(
        records.slice(start, start + 16).map(async (r, i) => {
          const data = new Uint8Array(r.data);
          if ((await sha256(data)) !== r.sha256)
            throw Error("SQLite CRC checksum mismatch");
          output.set(data, (start + i) * 8);
        }),
      );
    return output;
  }
  async prepareCommit(
    expected: number,
    value: SqlitePageCommit,
  ): Promise<SqlitePageTransaction> {
    const captured = capturePageCommit(value),
      records: DiskPage[] = [];
    const writeChecksums = !!(
      captured.checksums ||
      captured.checksumFormat ||
      captured.checksumSnapshot
    );
    if (writeChecksums && !this.readChecksums)
      throw Error("SQLite checksum provider unavailable");
    for (let start = 0; start < captured.pages.length; start += 16)
      records.push(
        ...(await Promise.all(
          captured.pages.slice(start, start + 16).map(async (p) => ({
            data: p.data.buffer as ArrayBuffer,
            sha256: await sha256(p.data),
          })),
        )),
      );
    const files = await Promise.all(
      (captured.files ?? []).map(async (f) => ({
        data: f.data.buffer as ArrayBuffer,
        sha256: await sha256(f.data),
      })),
    );
    const checksums: DiskPage[] = [];
    for (let start = 0; start < (captured.checksums?.length ?? 0); start += 16)
      checksums.push(
        ...(await Promise.all(
          captured.checksums!.slice(start, start + 16).map(async (c) => ({
            data: c.data.buffer as ArrayBuffer,
            sha256: await sha256(c.data),
          })),
        )),
      );
    let head: SqlitePageHead | undefined;
    return {
      stores: writeChecksums
        ? Object.values(this.names)
        : [this.names.head, this.names.pages, this.names.files],
      head: () => {
        if (!head) throw Error("uncommitted SQLite page transaction");
        return { ...head, ...(head.files ? { files: [...head.files] } : {}) };
      },
      apply: (tx, fail) => {
        const request = tx.objectStore(this.names.head).get(0);
        request.onsuccess = () => {
          try {
            head = nextPageHead(
              expected,
              validatePageHead(request.result),
              captured,
            );
            const pages = tx.objectStore(this.names.pages);
            if (captured.snapshot) pages.clear();
            else pages.delete(IDBKeyRange.lowerBound(head.pageCount + 1));
            captured.pages.forEach((p, i) => pages.put(records[i], p.page));
            if (writeChecksums) {
              const catalog = tx.objectStore(this.names.checksums);
              if (captured.checksumSnapshot) catalog.clear();
              else catalog.delete(IDBKeyRange.lowerBound(head.pageCount + 1));
              captured.checksums?.forEach((c, i) =>
                catalog.put(checksums[i], c.page),
              );
            }
            const attached = tx.objectStore(this.names.files);
            for (const name of captured.removeFiles ?? [])
              attached.delete(name);
            captured.files?.forEach((f, i) => attached.put(files[i], f.name));
            tx.objectStore(this.names.head).put(head, 0);
          } catch (e) {
            fail(e);
          }
        };
      },
    };
  }
  async commit(
    expected: number,
    value: SqlitePageCommit,
  ): Promise<SqlitePageHead> {
    const prepared = await this.prepareCommit(expected, value);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(prepared.stores, "readwrite", {
        durability: "strict",
      });
      let failure: unknown;
      const fail = (error: unknown) => {
        failure = error;
        try {
          tx.abort();
        } catch {}
      };
      try {
        prepared.apply(tx, fail);
      } catch (e) {
        fail(e);
      }
      tx.oncomplete = () => resolve(prepared.head());
      tx.onabort = tx.onerror = () =>
        reject(failure ?? tx.error ?? Error("SQLite page commit failed"));
    });
  }
  close() {
    if (this.ownsDatabase) this.db.close();
  }
}
