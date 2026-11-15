import type {
  Ack,
  ClientState,
  Database,
  Mode,
  Pending,
  ReplicaState,
  Snapshot,
  Statement,
  Value,
} from "./contract.ts";
import type {
  ClientOptions,
  ClientResolution,
  ExecuteOptions,
  OperationGuard,
  SyncIssue,
} from "./safety-contract.ts";
import { APP_SCHEMA, importSnapshot } from "./engine.ts";
import { pack, packStored, parseStatements, unpack } from "./protocol.ts";
import {
  bootstrapSafety,
  bumpSchema,
  encodeOperation,
  immutable,
  observeSQL,
  schemaStamp,
  setSchema,
} from "./safety.ts";
import { failure, issueOf, SyncFailure } from "./errors.ts";

export interface SessionDatabase extends Database {
  capture(body: () => void): Uint8Array;
}
export interface PreparedSnapshot {
  snapshot: Snapshot;
  commit(): void;
  dispose(): Promise<void>;
}
export interface Transport {
  push(bytes: Uint8Array): Promise<Ack>;
  snapshot(): Promise<Snapshot>;
  prepareSnapshot?(options?: { reset?: boolean }): Promise<PreparedSnapshot>;
  replicaState?(): ReplicaState | undefined;
}
/** Compatibility alias; new transports preserve the authority's structured issue. */
export class RemoteError extends SyncFailure {
  constructor(
    message: string,
    readonly conflict: boolean,
    issue?: SyncIssue,
  ) {
    super(
      issue ?? {
        kind: conflict ? "ambiguous" : "transport",
        code: conflict ? "conflict" : "unavailable",
        message,
        disposition: "defer",
        retryable: !conflict,
        authoritative: conflict,
      },
    );
  }
}
export class OfflineClient {
  private busy = false;
  constructor(
    readonly db: Database,
    private transport: Transport,
    private options: ClientOptions = {},
  ) {
    const attempts = options.retry?.attempts ?? 3;
    const delay = options.retry?.delayMs ?? 50;
    if (
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      attempts > 10 ||
      !Number.isFinite(delay) ||
      delay < 0 ||
      delay > 5000
    )
      throw new Error("invalid retry budget");
    db.run(APP_SCHEMA);
    db.run(
      "CREATE TABLE IF NOT EXISTS _bls_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL)",
    );
    db.run("INSERT OR IGNORE INTO _bls_state VALUES(1,0)");
    db.run(
      "CREATE TABLE IF NOT EXISTS _bls_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,body TEXT NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS _bls_resolutions(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
    );
    bootstrapSafety(db, false);
  }
  private revision(): number {
    return Number(
      this.db.all("SELECT revision FROM _bls_state WHERE id=1")[0]!.revision,
    );
  }
  pending(): Pending[] {
    return this.db
      .all("SELECT body FROM _bls_outbox ORDER BY seq")
      .map((r) => JSON.parse(String(r.body)) as Pending);
  }
  resolutions(): unknown[] {
    return this.db
      .all(
        "SELECT body FROM _bls_resolutions WHERE id NOT LIKE 'receipt:%' ORDER BY rowid",
      )
      .map((row) => JSON.parse(String(row.body)));
  }
  receipts(): { id: string; receipt: Ack }[] {
    return this.db
      .all(
        "SELECT body FROM _bls_resolutions WHERE id LIKE 'receipt:%' ORDER BY rowid",
      )
      .map((row) => JSON.parse(String(row.body)));
  }
  private save(op: Pending): void {
    this.db.run("UPDATE _bls_outbox SET body=? WHERE id=?", [
      JSON.stringify(op),
      op.id,
    ]);
  }
  execute(
    statements: Statement[],
    mode: Mode,
    options: ExecuteOptions = {},
  ): string {
    if (this.busy) throw new Error("sync or resolution is in progress");
    if (
      this.pending().some(
        (p) =>
          p.status === "deferred" ||
          p.status === "rejected" ||
          (p.status as string) === "conflict",
      )
    )
      throw new Error("resolve the deferred operation before editing");
    return this.db.transaction(() => this.enqueue(statements, mode, options));
  }
  private enqueue(
    statements: Statement[],
    mode: Mode,
    options: ExecuteOptions,
  ): string {
    if (mode !== "sql" && mode !== "changeset")
      throw new Error("invalid operation mode");
    if (mode === "changeset" && !this.db.capture)
      throw failure(
        "unsupported",
        "backend does not expose SQLite Session capture; use SQL mode",
        "resource",
        "reject",
      );
    const payload = new TextEncoder().encode(JSON.stringify(statements));
    parseStatements(payload);
    const guard: OperationGuard = {
      version: 2,
      schema: schemaStamp(this.db),
      policy: options.policy ?? "strict@1",
      intent: options.intent ?? null,
      assertions: options.assertions ?? [],
    };
    let body: Uint8Array;
    if (mode === "sql") {
      const execution = observeSQL(this.db, statements);
      guard.proof = execution.effects;
      if (execution.schemaChanged) bumpSchema(this.db);
      body = payload;
    } else
      body = this.db.capture!(() => {
        for (const stmt of statements)
          this.db.run(stmt.sql, stmt.params.map(unpack));
      });
    const base = this.revision() + this.pending().length;
    const id = crypto.randomUUID();
    const frame = encodeOperation(
      { kind: mode === "sql" ? 1 : 2, base, opId: id, payload: body },
      guard,
    );
    const op: Pending = {
      id,
      base,
      mode,
      frame: Array.from(frame),
      statements,
      options,
      status: "pending",
    };
    this.db.run("INSERT INTO _bls_outbox(id,body) VALUES(?,?)", [
      id,
      JSON.stringify(op),
    ]);
    return id;
  }
  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("sync or resolution is in progress");
    this.busy = true;
    try {
      return await body();
    } finally {
      this.busy = false;
    }
  }
  private async retry<T>(body: () => Promise<T>): Promise<T> {
    const attempts = Math.max(
      1,
      Math.min(10, this.options.retry?.attempts ?? 3),
    );
    const delay = Math.max(
      0,
      Math.min(5000, this.options.retry?.delayMs ?? 50),
    );
    for (let n = 0; ; n++) {
      try {
        return await body();
      } catch (error) {
        if (!issueOf(error).retryable || n + 1 >= attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay * (n + 1)));
      }
    }
  }
  async sync(): Promise<void> {
    await this.exclusive(() => this.synchronize(3));
  }
  private async synchronize(budget: number): Promise<void> {
    let highest = this.revision();
    for (const op of this.pending()) {
      if (op.receipt) {
        highest = Math.max(highest, op.receipt.revision);
        continue;
      }
      try {
        const receipt = await this.retry(() =>
          this.transport.push(Uint8Array.from(op.frame)),
        );
        if (
          !receipt ||
          !Number.isSafeInteger(receipt.revision) ||
          receipt.revision < 1
        )
          throw failure(
            "receipt",
            "invalid server receipt",
            "integrity",
            "reject",
          );
        highest = Math.max(highest, receipt.revision);
        this.db.transaction(() => {
          this.save({ ...op, receipt, status: "accepted", issue: undefined });
          this.db.run(
            "INSERT OR REPLACE INTO _bls_resolutions(id,body) VALUES(?,?)",
            [`receipt:${op.id}`, JSON.stringify({ id: op.id, receipt })],
          );
        });
      } catch (error) {
        const issue = issueOf(error);
        if (issue.authoritative === true && !issue.retryable) {
          this.save({
            ...op,
            status: issue.disposition === "reject" ? "rejected" : "deferred",
            issue,
          });
          if (this.options.onIssue) {
            const decision = await this.options.onIssue(
              immutable({ issue, pending: this.pending() }),
            );
            if (decision.action === "replace" && budget > 0) {
              await this.resolveInner(decision);
              return this.synchronize(budget - 1);
            }
            if (decision.action === "defer" || decision.action === "reject")
              this.save({
                ...op,
                status: decision.action === "reject" ? "rejected" : "deferred",
                issue: {
                  ...issue,
                  disposition: decision.action,
                  message: decision.reason,
                },
              });
          }
        }
        throw error;
      }
    }
    await this.install(this.pending(), highest);
  }
  private async prepared(): Promise<PreparedSnapshot> {
    let reset = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.retry(async () =>
          this.transport.prepareSnapshot
            ? this.transport.prepareSnapshot({ reset })
            : {
                snapshot: await this.transport.snapshot(),
                commit() {},
                async dispose() {},
              },
        );
      } catch (error) {
        if (!this.options.onReplicaIssue || attempt >= 2) throw error;
        const decision = await this.options.onReplicaIssue(
          immutable({
            issue: issueOf(error),
            replica: this.transport.replicaState?.(),
          }),
        );
        if (decision.action === "defer") throw error;
        if (decision.action === "resnapshot") {
          if (!this.transport.prepareSnapshot) throw error;
          reset = true;
        } else if (decision.action !== "retry")
          throw new Error("invalid replica recovery decision");
      }
    }
  }
  private async install(
    pending: Pending[],
    minimum: number,
    replace?: ClientResolution & { action: "replace" },
  ): Promise<void> {
    const prepared = await this.prepared();
    try {
      const snapshot = prepared.snapshot;
      if (snapshot.revision < minimum)
        throw failure(
          "regressed",
          "snapshot regressed behind acknowledged operations",
          "integrity",
        );
      const localEpoch = this.db.all(
        "SELECT epoch FROM _bls_schema WHERE id=1",
      )[0]?.epoch;
      if (
        !snapshot.schemaStamp ||
        (localEpoch && localEpoch !== snapshot.schemaStamp.epoch)
      )
        throw failure("database", "sync database identity changed", "schema");
      this.db.transaction(() => {
        importSnapshot(this.db, snapshot);
        setSchema(this.db, snapshot.schemaStamp);
        this.db.run("UPDATE _bls_state SET revision=? WHERE id=1", [
          BigInt(snapshot.revision),
        ]);
        for (const op of pending)
          this.db.run("DELETE FROM _bls_outbox WHERE id=?", [op.id]);
        prepared.commit();
        if (replace) {
          const ids = replace.operations.map((op) =>
            this.enqueue(op.statements, op.mode, op),
          );
          const record = {
            id: crypto.randomUUID(),
            reason: replace.reason,
            prior: pending,
            replacements: ids,
            revision: snapshot.revision,
            at: new Date().toISOString(),
          };
          this.db.run("INSERT INTO _bls_resolutions(id,body) VALUES(?,?)", [
            record.id,
            JSON.stringify(record),
          ]);
        }
      });
    } finally {
      await prepared.dispose();
    }
  }
  async resolvePending(decision: ClientResolution): Promise<void> {
    await this.exclusive(() => this.resolveInner(decision));
  }
  private async resolveInner(decision: ClientResolution): Promise<void> {
    if (
      !decision ||
      !["replace", "defer", "reject"].includes(decision.action) ||
      typeof decision.reason !== "string" ||
      !decision.reason.length
    )
      throw new Error("invalid client resolution");
    const pending = this.pending();
    const first = pending.find((op) => !op.receipt);
    if (!first || !first.issue || first.issue.authoritative !== true)
      throw new Error(
        "resolution requires a confirmed, uncommitted deferred operation; retry sync first",
      );
    if (decision.action !== "replace") {
      this.save({
        ...first,
        status: decision.action === "reject" ? "rejected" : "deferred",
        issue: {
          ...first.issue,
          message: decision.reason,
          disposition: decision.action,
        },
      });
      return;
    }
    if (
      !decision.reason ||
      !Array.isArray(decision.operations) ||
      decision.operations.length > 100
    )
      throw new Error("invalid client resolution");
    const highest = Math.max(
      this.revision(),
      ...pending.map((op) => op.receipt?.revision ?? 0),
    );
    await this.install(pending, highest, decision);
  }
  async discardPending(): Promise<void> {
    await this.exclusive(async () => {
      // Discover lost ACKs before destructive resolution. Rejected suffixes have
      // never committed; accepted prefixes are represented by durable receipts.
      try {
        await this.synchronize(0);
      } catch (error) {
        if (issueOf(error).kind === "transport") throw error;
        await this.resolveInner({
          action: "replace",
          reason: "user explicitly discarded uncommitted operations",
          operations: [],
        });
      }
    });
  }
  state(): ClientState {
    return {
      revision: this.revision(),
      pending: this.pending(),
      rows: this.db
        .all("SELECT * FROM notes ORDER BY id")
        .map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, packStored(v)])),
        ),
      replica: this.transport.replicaState?.(),
    };
  }
}
export function statement(sql: string, params: Value[] = []): Statement {
  return { sql, params: params.map(pack) };
}
