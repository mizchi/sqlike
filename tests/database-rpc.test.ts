import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseBridge, replyToDatabase } from "../src/database-rpc.ts";
import { TursoDatabase } from "../adapters/turso-database.ts";
import { failure } from "../src/errors.ts";

test("async-driver bridge preserves exact int64 and blobs", () => {
  const buffer = new SharedArrayBuffer(2048);
  const bridge = new DatabaseBridge(
    buffer,
    () =>
      replyToDatabase(buffer, {
        rows: [
          {
            n: { t: "integer", v: "9223372036854775806" },
            b: { t: "blob", v: [0, 255] },
          },
        ],
      }),
    () => {},
  );
  assert.deepEqual(bridge.all("SELECT n,b"), [
    { n: 9223372036854775806n, b: new Uint8Array([0, 255]) },
  ]);
});
test("a timed-out storage call poisons the connection and cannot be replayed implicitly", () => {
  let calls = 0;
  let stops = 0;
  const bridge = new DatabaseBridge(
    new SharedArrayBuffer(2048),
    () => {
      calls++;
    },
    () => {
      stops++;
    },
    1,
  );
  assert.throws(() => bridge.all("COMMIT"), /timed out/);
  assert.throws(() => bridge.all("ROLLBACK"), /reload/);
  assert.equal(calls, 1);
  assert.equal(stops, 1);
});
test("oversized bridge results are explicit resource failures", () => {
  const buffer = new SharedArrayBuffer(512);
  const bridge = new DatabaseBridge(
    buffer,
    () =>
      replyToDatabase(buffer, {
        rows: [{ n: { t: "text", v: "x".repeat(1024) } }],
      }),
    () => {},
  );
  assert.throws(
    () => bridge.all("SELECT big"),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "issue" in error &&
      (error.issue as { kind: string }).kind === "resource",
  );
});

test("failed rollback cannot turn an uncertain transaction into a confirmed rejection", () => {
  const db = Object.create(TursoDatabase.prototype) as TursoDatabase;
  let closed = false;
  Object.assign(db, {
    bridge: {
      close() {
        closed = true;
      },
    },
    run(sql: string) {
      if (sql === "ROLLBACK") throw new Error("lost connection");
    },
  });
  assert.throws(
    () =>
      db.transaction(() => {
        throw failure("policy-reject", "reject", "application", "reject");
      }),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "issue" in error &&
      (error.issue as { kind: string }).kind === "transport",
  );
  assert.equal(closed, true);
});

test("a driver SQL error remains a definite application rejection", () => {
  const buffer = new SharedArrayBuffer(2048);
  const reply = { error: "unsupported SQL feature", code: "SQLITE_ERROR" };
  const bridge = new DatabaseBridge(
    buffer,
    () => replyToDatabase(buffer, reply),
    () => {},
  );
  assert.throws(
    () => bridge.all("CREATE VIEW example AS SELECT 1"),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "issue" in error &&
      (error.issue as { kind: string }).kind === "application",
  );
});

test("SQL result cells preserve REAL and infinity without widening sync bindings", async () => {
  const { packResult, pack, unpack } = await import("../src/protocol.ts");
  for (const n of [-0, 1e100, Infinity, -Infinity]) {
    const cell = packResult(n);
    assert.equal(cell.t, "real");
    assert.equal(Object.is(unpack(JSON.parse(JSON.stringify(cell))), n), true);
  }
  assert.deepEqual(packResult(1), { t: "real", v: 1 });
  assert.throws(() => pack(Infinity), /bigint/);
  assert.throws(() => packResult(NaN), /NaN/);
  const buffer = new SharedArrayBuffer(2048);
  const bridge = new DatabaseBridge(
    buffer,
    () =>
      replyToDatabase(buffer, {
        rows: [{ n: packResult(Infinity), m: packResult(-Infinity) }],
      }),
    () => {},
  );
  assert.deepEqual(bridge.all("SELECT infinity"), [
    { n: Infinity, m: -Infinity },
  ]);
});
