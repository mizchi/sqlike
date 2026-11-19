import { fromBase64, toBase64 } from "../src/aot-values.ts";
import type { ImageDelta } from "../src/persistence-contract.ts";
import type { AotUploadBinding } from "../src/aot-upload-contract.ts";

export interface PendingFile {
  minTXID: string;
  maxTXID: string;
  data: string;
  sha256: string;
  size: number;
}
export interface SavedState {
  format: "moon-aot-store@1";
  programId: string;
  image: string;
  /** Small header for the binary chunks in the same logical publication. */
  logical?: string;
  head: string;
  acked: string;
  checkpointSerial: number;
  base: string;
  baseHash: string;
  pending: PendingFile[];
  upload?: AotUploadBinding;
  /** Page-backed bases/outbox use empty data strings in this logical envelope. */
  pager?: { format: "aot-pages@1"; generation: number };
}
interface Journal {
  format: "aot-journal@1";
  programId: string;
  core?: string;
  head?: string;
  acked?: string;
  checkpointSerial?: number;
  baseHash?: string;
  base?: number;
  put: (Omit<PendingFile, "data"> & { blob: number })[];
  remove: string[];
  upload?: AotUploadBinding;
  pager?: SavedState["pager"];
}
/** Only changed side records are submitted; unchanged base/outbox bytes are
 * never serialized on a row write or acknowledgement. */
export function aotJournal(
  before: SavedState,
  after: SavedState,
  core?: string,
): ImageDelta {
  const blobs: Uint8Array[] = [];
  const attach = (text: string) => {
    blobs.push(fromBase64(text));
    return blobs.length - 1;
  };
  const journal: Journal = {
    format: "aot-journal@1",
    programId: after.programId,
    put: [],
    remove: [],
    ...(core ? { core } : {}),
  };
  for (const key of ["head", "acked", "checkpointSerial", "baseHash"] as const)
    if (before[key] !== after[key])
      Object.assign(journal, { [key]: after[key] });
  if (before.base !== after.base) journal.base = attach(after.base);
  if (JSON.stringify(before.pager) !== JSON.stringify(after.pager))
    journal.pager = after.pager;
  if (JSON.stringify(before.upload) !== JSON.stringify(after.upload)) {
    if (before.upload || !after.upload)
      throw Error("cannot replace LTX upload binding");
    journal.upload = after.upload;
  }
  const previous = new Map(before.pending.map((f) => [f.maxTXID, f]));
  for (const file of after.pending) {
    const old = previous.get(file.maxTXID);
    if (!old || old.sha256 !== file.sha256) {
      const { data, ...meta } = file;
      journal.put.push({ ...meta, blob: attach(data) });
    }
    previous.delete(file.maxTXID);
  }
  journal.remove = [...previous.keys()];
  return { text: JSON.stringify(journal), ...(blobs.length ? { blobs } : {}) };
}

export function applyAotJournal(
  saved: SavedState,
  delta: ImageDelta,
): { saved: SavedState; core?: string } {
  const j = JSON.parse(delta.text) as Journal;
  if (
    j.format !== "aot-journal@1" ||
    j.programId !== saved.programId ||
    !Array.isArray(j.put) ||
    !Array.isArray(j.remove) ||
    (j.core !== undefined && typeof j.core !== "string")
  )
    throw Error("invalid AOT journal");
  const next = { ...saved, pending: saved.pending.slice() };
  if (j.pager !== undefined) {
    if (
      j.pager.format !== "aot-pages@1" ||
      !Number.isSafeInteger(j.pager.generation) ||
      j.pager.generation < 1 ||
      j.pager.generation !== (saved.pager?.generation ?? 0) + 1
    )
      throw Error("invalid AOT page journal generation");
    next.pager = j.pager;
  }
  if (j.upload !== undefined) {
    if (saved.upload !== undefined)
      throw Error("cannot replace saved LTX upload binding");
    next.upload = j.upload;
  }
  for (const key of ["head", "acked", "baseHash"] as const)
    if (j[key] !== undefined) {
      if (typeof j[key] !== "string")
        throw Error("invalid AOT journal metadata");
      next[key] = j[key];
    }
  if (j.checkpointSerial !== undefined) {
    if (!Number.isSafeInteger(j.checkpointSerial) || j.checkpointSerial < -1)
      throw Error("invalid AOT journal serial");
    next.checkpointSerial = j.checkpointSerial;
  }
  const blob = (index: number): string => {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      !(delta.blobs?.[index] instanceof Uint8Array)
    )
      throw Error("missing AOT journal blob");
    return toBase64(delta.blobs[index]!);
  };
  if (j.base !== undefined) next.base = blob(j.base);
  for (const id of j.remove) {
    if (typeof id !== "string" || !next.pending.some((f) => f.maxTXID === id))
      throw Error("missing AOT journal outbox entry");
    next.pending = next.pending.filter((f) => f.maxTXID !== id);
  }
  for (const entry of j.put) {
    const { blob: index, ...meta } = entry;
    if (next.pending.some((f) => f.maxTXID === entry.maxTXID))
      throw Error("duplicate AOT journal file");
    next.pending.push({ ...meta, data: blob(index) });
  }
  return { saved: next, core: j.core };
}
