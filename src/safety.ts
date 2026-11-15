import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Database, Frame, Statement, Value } from "./contract.ts";
import type { Execution, OperationGuard, ReadAssertion, ReadonlyQuery, SchemaStamp, StatementEffect } from "./safety-contract.ts";
import { decodeFrame, encodeFrame, isInternalTable, packStored, parseStatements, quote, unpack } from "./protocol.ts";
import { failure } from "./errors.ts";
import {schemaSQL} from "./schema-sql.ts";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export const digest = (value: unknown): string => bytesToHex(sha256(utf8ToBytes(stable(value))));
const rows = (records: Record<string, Value>[]) => records.map(record => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, packStored(value)])));

export function bootstrapSafety(db: Database, authority: boolean): void {
  db.run("CREATE TABLE IF NOT EXISTS _bls_schema(id INTEGER PRIMARY KEY,epoch TEXT,generation INTEGER NOT NULL,cookie INTEGER)");
  if (!db.all("PRAGMA table_info(_bls_schema)").some(c => c.name === "cookie")) db.run("ALTER TABLE _bls_schema ADD COLUMN cookie INTEGER");
  db.run("CREATE TABLE IF NOT EXISTS _bls_probe(id INTEGER)");
  db.run("INSERT OR IGNORE INTO _bls_schema(id,epoch,generation,cookie) VALUES(1,?,0,?)", [authority ? crypto.randomUUID() : null, BigInt(schemaCookie(db))]);
  db.run("UPDATE _bls_schema SET cookie=? WHERE id=1 AND cookie IS NULL", [BigInt(schemaCookie(db))]);
}
function schemaCookie(db: Database): number { return db.schemaVersion?.() ?? 0; }
/** SQLite's cookie also catches external DROP/recreate with identical SQL text. */
export function reconcileSchema(db: Database): SchemaStamp {
  const row = db.all("SELECT cookie FROM _bls_schema WHERE id=1")[0]; const cookie = schemaCookie(db);
  if (Number(row?.cookie) !== cookie) db.run("UPDATE _bls_schema SET generation=generation+1,cookie=? WHERE id=1", [BigInt(cookie)]);
  return schemaStamp(db);
}
export function schemaSignature(db: Database): string {
  const schema = db.all("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL")
    .filter(row => !isInternalTable(String(row.name))).map(row=>({...row,sql:schemaSQL(String(row.sql))})).sort((a, b) => stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0);
  return digest(schema);
}
export function schemaStamp(db: Database): SchemaStamp {
  const state = db.all("SELECT epoch,generation,cookie FROM _bls_schema WHERE id=1")[0];
  if (!state?.epoch) throw failure("bootstrap", "initial sync is required before editing", "schema");
  if (Number(state.cookie) !== schemaCookie(db)) throw failure("schema", "untracked schema change; refresh the schema contract", "schema");
  return { epoch: String(state.epoch), generation: Number(state.generation), signature: schemaSignature(db) };
}
export function setSchema(db: Database, stamp: SchemaStamp): void {
  if (!validStamp(stamp) || schemaSignature(db) !== stamp.signature) throw failure("schema", "snapshot schema signature mismatch", "integrity");
  db.run("UPDATE _bls_schema SET epoch=?,generation=?,cookie=? WHERE id=1", [stamp.epoch, BigInt(stamp.generation), BigInt(schemaCookie(db))]);
}
export function bumpSchema(db: Database): void { db.run("UPDATE _bls_schema SET generation=generation+1,cookie=? WHERE id=1", [BigInt(schemaCookie(db))]); }

function image(db: Database): Map<string, string[]> {
  const tables = db.all("SELECT name,sql FROM sqlite_schema WHERE type='table'").filter(row => !isInternalTable(String(row.name)));
  return new Map(tables.map(table => {
    if (/CREATE\s+VIRTUAL/i.test(String(table.sql))) throw failure("unsupported", "proofs require ordinary tables", "resource", "reject");
    return [String(table.name), rows(db.all(`SELECT * FROM ${quote(String(table.name))}`)).map(stable).sort()];
  }));
}
function changes(before: Map<string, string[]>, after: Map<string, string[]>): unknown {
  const difference = [];
  for (const table of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const counts = new Map<string, number>();
    for (const row of before.get(table) ?? []) counts.set(row, (counts.get(row) ?? 0) - 1);
    for (const row of after.get(table) ?? []) counts.set(row, (counts.get(row) ?? 0) + 1);
    const changed = [...counts].filter(([, count]) => count).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (changed.length) difference.push({ table, changed });
  }
  return difference;
}
/** Must run inside the caller's transaction; a mismatch rolls the entire trial back. */
export function observeSQL(db: Database, statements: Statement[]): Execution {
  const effects: StatementEffect[] = []; const results: Execution["results"] = []; let schemaChanged = false;
  parseStatements(new TextEncoder().encode(JSON.stringify(statements)));
  for (const stmt of statements) {
    const signature = schemaSignature(db); const before = image(db);
    db.run("DELETE FROM _bls_probe"); // Reset changes(), including after SELECT or DDL.
    const returned = rows(db.all(stmt.sql, stmt.params.map(unpack)));
    const affected = Number(db.all("SELECT changes() AS n")[0]!.n);
    const after = image(db); const schema = schemaSignature(db);
    schemaChanged ||= signature !== schema;
    effects.push({ affected, changes: digest(changes(before, after)), result: digest(returned), schema });
    results.push(returned);
  }
  return { effects, results, schemaChanged };
}
export function readOnly(db: Database): ReadonlyQuery {
  return stmt => {
    parseStatements(new TextEncoder().encode(JSON.stringify([stmt])));
    if (!/^select\b/i.test(stmt.sql.trim())) throw failure("policy-query", "policy queries must be SELECT statements", "application", "reject");
    return db.all(stmt.sql, stmt.params.map(unpack));
  };
}
export function assertReads(assertions: ReadAssertion[], read: ReadonlyQuery): void {
  for (const assertion of assertions) {
    const actual = read(assertion.query).length;
    if (actual !== assertion.exactly) {
      const error = failure("cardinality", `ambiguous target ${assertion.name}: expected ${assertion.exactly} row(s), got ${actual}`);
      error.issue.details = { name: assertion.name, expected: assertion.exactly, actual };
      throw error;
    }
  }
}
function validStamp(stamp: SchemaStamp): boolean {
  return !!stamp && /^[0-9a-f-]{36}$/.test(stamp.epoch) && Number.isSafeInteger(stamp.generation) && stamp.generation >= 0 && /^[0-9a-f]{64}$/.test(stamp.signature);
}
function validAssertions(assertions: ReadAssertion[]): boolean {
  return Array.isArray(assertions) && assertions.length <= 100 && assertions.every(a => a && typeof a.name === "string" && Number.isSafeInteger(a.exactly) && a.exactly >= 0 && a.query && typeof a.query.sql === "string" && Array.isArray(a.query.params));
}
export function validateGuard(guard: OperationGuard, kind: Frame["kind"]): void {
  if (!guard || guard.version !== 2 || !validStamp(guard.schema) || typeof guard.policy !== "string" || !/^[\w.-]+@[\w.-]+$/.test(guard.policy) || !validAssertions(guard.assertions) || guard.intent === undefined) throw failure("guard", "missing or invalid application guard", "integrity", "reject");
  if (kind === 1 && (!Array.isArray(guard.proof) || !guard.proof.length || guard.proof.length > 100 || guard.proof.some(p => !p || !Number.isSafeInteger(p.affected) || p.affected < 0 || ![p.changes, p.result, p.schema].every(hash => /^[0-9a-f]{64}$/.test(hash))))) throw failure("proof", "SQL preview proof is required", "integrity", "reject");
}
export function encodeOperation(frame: Frame, guard: OperationGuard): Uint8Array {
  validateGuard(guard, frame.kind);
  const meta = new TextEncoder().encode(JSON.stringify(guard));
  if (meta.length > 65536) throw failure("guard-size", "operation guard exceeds 64 KiB", "resource", "reject");
  const payload = new Uint8Array(8 + meta.length + frame.payload.length);
  payload.set(new TextEncoder().encode("BGC2")); new DataView(payload.buffer).setUint32(4, meta.length);
  payload.set(meta, 8); payload.set(frame.payload, 8 + meta.length);
  return encodeFrame({ ...frame, payload });
}
export function decodeOperation(frame: Frame): { guard: OperationGuard; payload: Uint8Array } {
  const p = frame.payload;
  if (p.length < 8 || new TextDecoder().decode(p.subarray(0, 4)) !== "BGC2") throw failure("protocol", "unguarded operation rejected; rebase legacy outbox explicitly", "integrity", "reject");
  const size = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(4);
  if (size > 65536 || size > p.length - 8) throw failure("guard", "truncated operation guard", "integrity", "reject");
  let guard: OperationGuard;
  try { guard = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(p.subarray(8, 8 + size))); }
  catch { throw failure("guard", "invalid operation guard JSON", "integrity", "reject"); }
  validateGuard(guard, frame.kind);
  return { guard, payload: p.subarray(8 + size) };
}
export function immutable<T>(value: T): T {
  const cloned: T = JSON.parse(JSON.stringify(value));
  const freeze = (v: unknown): void => { if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } };
  freeze(cloned); return cloned;
}
