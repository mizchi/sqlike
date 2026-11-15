import * as core from "../_build/js/release/build/mizchi/litestream/litestream.js";
import type { Cell, ResultCell, Change, Frame, Statement, Value } from "./contract.ts";

export const MAX_FRAME = 1048576 + 271;
export const sqlAllowed = core.sql_allowed;
export const revisionDecision = core.revision_decision;
export const isInternalTable = (name: string): boolean => ["_bls_", "_litestream_", "sqlite_", "__turso_"].some(prefix => name.toLowerCase().startsWith(prefix));

function parsed<T>(json: string): T {
  const value = JSON.parse(json);
  if (value?.error) throw new Error(value.error);
  return value as T;
}
export function encodeFrame(frame: Frame): Uint8Array {
  if (!Number.isInteger(frame.base) || frame.base < 0 || frame.base > 0x7fffffff) throw new Error("invalid revision");
  const bytes = core.encode_frame(frame.kind, frame.base, frame.opId, frame.payload);
  if (!bytes.length) throw new Error("invalid frame");
  return bytes;
}
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length > MAX_FRAME) throw new Error("frame too large");
  const frame = parsed<Omit<Frame, "payload"> & { payload: number[] }>(core.decode_frame(bytes));
  return { ...frame, payload: Uint8Array.from(frame.payload) };
}
export function decodeChangeset(bytes: Uint8Array): Change[] {
  return parsed<Change[]>(core.decode_changeset(bytes));
}
export function planChanges(changes: Change[], schema: Record<string, string[]>): { check: Statement | null; write: Statement }[] {
  return parsed(core.plan_changes(JSON.stringify(changes), JSON.stringify(schema)));
}
export function pack(value: Value): Cell {
  if (value === null) return { t: "null" };
  if (typeof value === "bigint") return { t: "integer", v: String(value) };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("use bigint for exact int64 values");
    return Number.isInteger(value) ? { t: "integer", v: String(value) } : { t: "real", v: value };
  }
  if (typeof value === "string") return { t: "text", v: value };
  return { t: "blob", v: Array.from(value) };
}
/** Query results carry REAL numbers independently of integer-only bind validation. */
export function packResult(value: Value): ResultCell {
  if (typeof value !== "number") return pack(value);
  if (Number.isNaN(value)) throw Error("invalid NaN SQL result");
  return { t: "real", v: value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : Object.is(value, -0) ? "-0" : value };
}
/** Values already read from a database: bigint is INTEGER, number is REAL.
 * Sync cells are JSON numbers; unsupported REALs must reject rather than round. */
export function packStored(value: Value): Cell {
  if (typeof value !== "number") return pack(value);
  if (!Number.isFinite(value) || Object.is(value, -0)) throw Error("unsupported sync REAL value");
  return { t: "real", v: value };
}
export function unpack(cell: ResultCell): Value {
  switch (cell.t) {
    case "null": return null;
    case "integer": return BigInt(cell.v);
    case "real":
      if (typeof cell.v === "number") return cell.v;
      if (cell.v === "Infinity") return Infinity;
      if (cell.v === "-Infinity") return -Infinity;
      if (cell.v === "-0") return -0;
      throw Error("invalid REAL result");
    case "text": return cell.v;
    case "blob": return Uint8Array.from(cell.v);
    default: throw new Error("undefined value cannot be bound");
  }
}
export function parseStatements(bytes: Uint8Array): Statement[] {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("expected 1..100 statements");
  for (const item of value) {
    if (!item || typeof item.sql !== "string" || !sqlAllowed(item.sql) || !Array.isArray(item.params)) throw new Error("SQL policy rejected statement");
    for (const cell of item.params) validateCell(cell);
  }
  return value as Statement[];
}
function validateCell(cell: Cell): void {
  if (!cell || typeof cell !== "object") throw new Error("invalid cell");
  switch (cell.t) {
    case "null": return;
    case "integer": if (typeof cell.v === "string" && /^-?\d+$/.test(cell.v) && BigInt(cell.v) >= -(1n << 63n) && BigInt(cell.v) < 1n << 63n) return; break;
    case "real": if (typeof cell.v === "number" && Number.isFinite(cell.v)) return; break;
    case "text": if (typeof cell.v === "string") return; break;
    case "blob": if (Array.isArray(cell.v) && cell.v.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) return; break;
  }
  throw new Error("invalid cell");
}
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
