import type { Ack, Change, Database, Snapshot } from "./contract.ts";
import type { AmbiguousDecision, ApplyPolicy, EngineOptions, GateDecision, OperationGuard, PolicyContext } from "./safety-contract.ts";
import { decodeChangeset, decodeFrame, isInternalTable, packStored, planChanges, quote, unpack } from "./protocol.ts";
import { assess_apply } from "../_build/js/release/build/mizchi/litestream/litestream.js";
import { assertReads, bootstrapSafety, bumpSchema, decodeOperation, digest, immutable, observeSQL, readOnly, reconcileSchema, schemaSignature, schemaStamp, validateGuard } from "./safety.ts";
import { failure, SyncFailure } from "./errors.ts";
import { parseStatements } from "./protocol.ts";
import { MAX_RESPONSE } from "./http.ts";
import { readSchemaEntries } from "./schema-entries.ts";

export const APP_SCHEMA = "CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,score INTEGER NOT NULL DEFAULT 0,payload BLOB)";
export class SyncError extends SyncFailure {
  constructor(public code: string, message = code) { super({ code, message, kind: "ambiguous", disposition: "defer", retryable: false }); }
}

function policyCall<T extends GateDecision | AmbiguousDecision>(callback: (() => T) | undefined, fallback: T): T {
  if (!callback) return fallback;
  try {
    const decision = callback();
    if (!decision || typeof decision !== "object" || "then" in decision || !["apply", "defer", "reject", "resolve"].includes(decision.action)) throw new Error("invalid or asynchronous policy decision");
    if (decision.action !== "apply" && (typeof decision.reason !== "string" || !decision.reason.length)) throw new Error("policy reason is required");
    return decision;
  } catch (error) { throw failure("policy-error", `policy failed: ${error instanceof Error ? error.message : String(error)}`, "application", "reject"); }
}
function gate(decision: GateDecision): void {
  if (decision.action === "apply") return;
  if (decision.action !== "defer" && decision.action !== "reject") throw failure("policy-error", "invalid gate policy decision", "application", "reject");
  throw failure(`policy-${decision.action}`, decision.reason, "application", decision.action);
}

export class SyncEngine {
  constructor(readonly db: Database, private initialize = true, private options: EngineOptions = {}) {
    if (initialize) {
      db.run(APP_SCHEMA);
      db.run("CREATE TABLE IF NOT EXISTS _bls_log(revision INTEGER PRIMARY KEY AUTOINCREMENT,op_id TEXT UNIQUE NOT NULL,frame BLOB NOT NULL,receipt TEXT)");
      if (!db.all("PRAGMA table_info(_bls_log)").some(c => c.name === "receipt")) db.run("ALTER TABLE _bls_log ADD COLUMN receipt TEXT");
      bootstrapSafety(db, true);
    }
  }
  push(bytes: Uint8Array): Ack {
    try { return this.apply(bytes); }
    catch (error) {
      if (error instanceof SyncFailure && error.issue.kind !== "transport") error.issue.authoritative = true;
      throw error;
    }
  }
  private apply(bytes: Uint8Array): Ack {
    const frame = decodeFrame(bytes);
    let context: PolicyContext | undefined;
    let policy: ApplyPolicy | undefined;
    let guard: OperationGuard | undefined;
    try {
      return (frame.kind === 2 && this.db.replicaTransaction ? this.db.replicaTransaction.bind(this.db) : this.db.transaction.bind(this.db))(() => {
        const prior = this.duplicate(frame.opId, bytes); if (prior) return prior;
        reconcileSchema(this.db);
        const operation = decodeOperation(frame); guard = operation.guard;
        policy = Object.hasOwn(this.options.policies ?? {}, guard.policy) ? this.options.policies![guard.policy] : guard.policy === "strict@1" ? {} : undefined;
        if (!policy) throw failure("policy-unknown", `unknown application policy: ${guard.policy}`, "application", "reject");
        context = { opId: frame.opId, mode: frame.kind === 1 ? "sql" : "changeset", base: frame.base, head: this.revision(), guard, schema: schemaStamp(this.db) };
        if (frame.kind === 1) context.statements = parseStatements(operation.payload);
        else {
          try { context.changes = decodeChangeset(operation.payload); }
          catch { throw failure("changeset", "invalid native changeset", "integrity", "reject"); }
        }
        const assessment = assess_apply(context.head, frame.base, frame.kind, context.schema.epoch === guard.schema.epoch, context.schema.generation === guard.schema.generation && context.schema.signature === guard.schema.signature, true, true);
        const read = readOnly(this.db);
        if (assessment === "database") throw failure("database", "database identity mismatch", "schema");
        gate(policyCall(policy.before ? () => policy!.before!(immutable(context!), read) : undefined, { action: "apply" }));
        if (assessment !== "apply") throw failure(assessment, `${assessment}: operation precondition failed`, assessment === "schema" ? "schema" : "ambiguous");
        assertReads(guard.assertions, read);
        let results: Ack["results"];
        if (frame.kind === 1) {
          const execution = observeSQL(this.db, context.statements!); context.actual = execution.effects; results = execution.results;
          if (assess_apply(context.head, frame.base, frame.kind, true, true, true, digest(guard.proof) === digest(execution.effects)) !== "apply") throw failure("effects", "SQL effect differs from local preview");
          if (execution.schemaChanged) bumpSchema(this.db);
        } else {
          validateChanges(this.db, context.changes!);
          if (this.db.applyMaterialized && this.db.replicaTransaction) {
            const signature = schemaSignature(this.db);
            this.db.applyMaterialized(() => applyChanges(this.db, context!.changes!));
            if (schemaSignature(this.db) !== signature) throw failure("schema", "materialized apply changed the logical schema", "integrity", "reject");
            this.db.run("UPDATE _bls_schema SET cookie=? WHERE id=1", [BigInt(this.db.schemaVersion?.() ?? 0)]);
          } else if (this.db.applyNativeChangeset) this.db.applyNativeChangeset(operation.payload);
          else applyChanges(this.db, context.changes!);
        }
        gate(policyCall(policy.after ? () => policy!.after!(immutable({ ...context!, schema: schemaStamp(this.db) }), read) : undefined, { action: "apply" }));
        return this.record(bytes, frame.opId, { outcome: "applied", results });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const constraint = !!error && typeof error === "object" && (("code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) || ("errcode" in error && typeof error.errcode === "number" && (error.errcode & 255) === 19));
      const problem = error instanceof SyncFailure ? error : constraint || /constraint|changeset conflict|old-value conflict/i.test(message)
        ? failure("conflict", `changeset or SQL conflict: ${message}`)
        : new SyncFailure({ kind: "transport", code: "authority-unavailable", message, disposition: "defer", retryable: true });
      if (!context || !guard || !policy?.onAmbiguous || !["ambiguous", "schema"].includes(problem.issue.kind) || problem.issue.code === "database") throw problem;
      const failed = context;
      return this.db.transaction(() => {
        const prior = this.duplicate(frame.opId, bytes); if (prior) return prior;
        const current = reconcileSchema(this.db);
        if (this.revision() !== failed.head || digest(current) !== digest(failed.schema)) throw failure("race", "authority changed while resolving; retry the original operation");
        const read = readOnly(this.db);
        gate(policyCall(policy!.before ? () => policy!.before!(immutable({ ...failed, issue: problem.issue }), read) : undefined, { action: "apply" }));
        const decision = policyCall(() => policy!.onAmbiguous!(immutable({ ...failed, issue: problem.issue }), read), { action: "defer", reason: problem.message });
        if (decision.action !== "resolve") {
          if (!["defer", "reject"].includes(decision.action)) throw failure("policy-error", "ambiguous operations require explicit replacement statements", "application", "reject");
          throw failure(problem.issue.code, decision.reason, problem.issue.kind, decision.action);
        }
        validateGuard({ ...guard!, assertions: decision.assertions }, 2);
        assertReads(decision.assertions, read);
        const execution = observeSQL(this.db, decision.statements);
        if (execution.schemaChanged) bumpSchema(this.db);
        const resolved = { ...failed, schema: schemaStamp(this.db), actual: execution.effects, issue: problem.issue };
        gate(policyCall(policy!.after ? () => policy!.after!(immutable(resolved), read) : undefined, { action: "apply" }));
        return this.record(bytes, frame.opId, { outcome: "resolved", reason: decision.reason, results: execution.results });
      });
    }
  }
  private duplicate(id: string, bytes: Uint8Array): Ack | undefined {
    const prior = this.db.all("SELECT revision,frame,receipt FROM _bls_log WHERE op_id=?", [id])[0];
    if (!prior) return undefined;
    const original = prior.frame as Uint8Array;
    if (original.length !== bytes.length || original.some((b, i) => b !== bytes[i])) throw failure("identity", "operation identity reused with different bytes", "integrity", "reject");
    const receipt = prior.receipt ? JSON.parse(String(prior.receipt)) as Ack : { revision: Number(prior.revision), outcome: "applied" as const };
    return { ...receipt, duplicate: true };
  }
  private record(bytes: Uint8Array, id: string, result: Pick<Ack, "outcome" | "reason" | "results">): Ack {
    const head = this.revision(); if (head === 0x7fffffff) throw failure("revision", "revision exhausted", "resource", "reject");
    const receipt: Ack = { revision: head + 1, duplicate: false, ...result };
    const serialized = JSON.stringify(receipt);
    if (new TextEncoder().encode(serialized).length > MAX_RESPONSE) throw failure("receipt-size", "operation result exceeds the 64 MiB response limit", "resource");
    this.db.run("INSERT INTO _bls_log(revision,op_id,frame,receipt) VALUES(?,?,?,?)", [BigInt(receipt.revision), id, bytes, serialized]);
    return receipt;
  }
  revision(): number { return Number(this.db.all("SELECT COALESCE(MAX(revision),0) AS revision FROM _bls_log")[0]!.revision); }
  /** Trusted migration entrypoint, including platforms without schema cookies. */
  migrate(statements: import("./contract.ts").Statement[]): import("./safety-contract.ts").SchemaStamp {
    // Owner-supplied schema programs may contain trigger-body semicolons. This
    // method is not exposed by the wire protocol; push() still uses parseStatements.
    return this.db.transaction(() => {
      for (const stmt of statements) this.db.run(stmt.sql, stmt.params.map(unpack));
      bumpSchema(this.db);
      return schemaStamp(this.db);
    });
  }
  schema(): import("./safety-contract.ts").SchemaStamp { return this.db.transaction(() => reconcileSchema(this.db)); }
  snapshot(): Snapshot {
    return this.db.transaction(() => {
      const stamp = this.initialize ? reconcileSchema(this.db) : schemaStamp(this.db);
      const schema = readSchemaEntries(this.db).filter(r => !isInternalTable(r.name));
      const tables = schema.filter(r => r.type === "table").map(r => {
        const name = String(r.name);
        if (/CREATE\s+VIRTUAL/i.test(String(r.sql))) throw new SyncError("unsupported", "snapshot requires ordinary tables");
        const columns = this.db.all(`PRAGMA table_xinfo(${quote(name)})`).filter(c => Number(c.hidden) === 0).map(c => String(c.name));
        const rows = this.db.all(`SELECT ${columns.map(quote).join(",")} FROM ${quote(name)}`).map(row => columns.map(c => packStored(row[c]!)));
        return { name, sql: String(r.sql), columns, rows };
      });
      return { revision: this.revision(), tables, schema: schema.filter(r => r.type !== "table").map(r => String(r.sql)), schemaStamp: stamp };
    });
  }
}

/** Schema and row validation is shared; side effects require a driver scope. */
export function validateChanges(db: Database, changes: Change[], captured = false): void {
  if (changes.length && !captured && !(db.applyMaterialized && db.replicaTransaction) &&
      (db.all("SELECT name FROM sqlite_schema WHERE type='trigger'").length ||
       db.all("SELECT name FROM sqlite_schema WHERE type='table'").some(t => db.all(`PRAGMA foreign_key_list(${quote(String(t.name))})`).length))) {
    throw new SyncError("unsupported", "binary trigger/FK schemas require materialized replication");
  }
  const schemas = new Map<string, ReturnType<Database["all"]>>();
  for (const c of changes) {
    let info = schemas.get(c.table);
    if (!info) {
      info = db.all(`PRAGMA table_xinfo(${quote(c.table)})`);
      const definition = db.all("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", [c.table])[0];
      if (!definition || /CREATE\s+VIRTUAL/i.test(String(definition.sql))) throw new SyncError("schema", "changeset schema mismatch");
      schemas.set(c.table, info);
    }
    if (info.length !== c.pk.length || info.some((col, i) => Number(col.pk) !== c.pk[i] || Number(col.hidden) !== 0)) throw new SyncError("schema", "changeset schema mismatch");
    const record = c.op === 18 ? c.new : c.old;
    if (record.length !== info.length || (c.op === 23 && c.new.length !== info.length)) throw new SyncError("schema");
    if (record.some((v, i) => c.pk[i] && (v.t === "undefined" || v.t === "null"))) throw new SyncError("schema", "primary keys must be non-null");
    if (c.op !== 23 && record.some(v => v.t === "undefined")) throw new SyncError("schema");
    if (c.op === 23 && c.new.some((v, i) => c.pk[i] && v.t !== "undefined")) throw new SyncError("schema", "updates cannot replace primary keys");
  }
}

/** Same old-value checks as Session's ABORT policy, inside the outer transaction. */
export function applyChanges(db: Database, changes: Change[]): void {
  const schema = Object.fromEntries([...new Set(changes.map(c => c.table))].map(table => [table, db.all(`PRAGMA table_info(${quote(table)})`).map(r => String(r.name))]));
  for (const plan of planChanges(changes, schema)) {
    if (plan.check && db.all(plan.check.sql, plan.check.params.map(unpack)).length !== 1) throw new SyncError("conflict", "changeset old-value conflict");
    db.run(plan.write.sql, plan.write.params.map(unpack));
  }
}

export function importSnapshot(db: Database, snapshot: Snapshot): void {
  // The caller owns the outer transaction. Snapshot table creation order need
  // not match FK dependencies, including cycles; validate before restoring
  // immediate checking for subsequent user operations in that transaction.
  db.run("PRAGMA defer_foreign_keys=ON");
  const schema = db.all("SELECT name,type FROM sqlite_schema WHERE sql IS NOT NULL").filter(r => !isInternalTable(String(r.name)));
  for (const item of schema.filter(r => r.type === "trigger" || r.type === "view")) db.run(`DROP ${String(item.type).toUpperCase()} ${quote(String(item.name))}`);
  for (const item of schema.filter(r => r.type === "table")) db.run(`DROP TABLE ${quote(String(item.name))}`);
  for(const t of snapshot.tables)db.run(t.sql);
  const indexes=snapshot.schema.filter(sql=>/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(sql));
  for(const sql of indexes)db.run(sql);
  for (const t of snapshot.tables) {
    for (const row of t.rows) db.run(`INSERT INTO ${quote(t.name)}(${t.columns.map(quote).join(",")}) VALUES (${row.map(() => "?").join(",")})`, row.map(unpack));
  }
  for (const sql of snapshot.schema.filter(sql=>!indexes.includes(sql))) db.run(sql);
  if(db.all("PRAGMA foreign_key_check").length)throw failure("snapshot-foreign-key","snapshot violates foreign key constraints","integrity","reject");
  db.run("PRAGMA defer_foreign_keys=OFF");
}
