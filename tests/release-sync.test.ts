import { test } from "node:test";
import assert from "node:assert/strict";
import { MoonDatabase } from "../adapters/moon-database.ts";
import { NodeDatabase } from "../adapters/node-database.ts";
import { SyncEngine } from "../src/engine.ts";
import { OfflineClient } from "../src/client.ts";
import { withMaterializedReplication } from "../src/materialized-replication.ts";
import { packStored } from "../src/protocol.ts";
import { value } from "./compatibility/differential-core.ts";
import { typedRows } from "./compatibility/feature-audit.ts";
import {
  releaseSchema,
  releaseSeed,
  releaseObserve,
} from "./compatibility/release-scenarios.ts";
import type { Statement, Value } from "../src/contract.ts";
const st = (sql: string, params: Value[] = []): Statement => ({
  sql,
  params: params.map(packStored),
});
for (const authority of ["sqlite", "sqlike"] as const)
  for (const mode of ["sql", "changeset"] as const)
    test(`R01 ${authority}/${mode}: full application schema syncs once after ACK loss and rejects partial trigger failure`, async () => {
      const raw =
          authority === "sqlite"
            ? new NodeDatabase(":memory:")
            : new MoonDatabase(),
        localRaw = new MoonDatabase();
      const server = withMaterializedReplication(raw),
        local = withMaterializedReplication(localRaw),
        engine = new SyncEngine(server);
      let lose = false;
      const transport = {
        snapshot: async () => engine.snapshot(),
        push: async (bytes: Uint8Array) => {
          const ack = engine.push(bytes);
          if (lose) {
            lose = false;
            throw Error("lost release ACK");
          }
          return ack;
        },
      };
      let client = new OfflineClient(local, transport, {
        retry: { attempts: 1 },
      });
      try {
        engine.migrate([
          ...releaseSchema.map((sql) => st(sql)),
          ...releaseSeed.map((o) => st(o.sql, (o.params ?? []).map(value))),
        ]);
        await client.sync();
        const rows = () =>
          releaseObserve.map((q) =>
            typedRows(local.all(q.sql).map(Object.values)),
          );
        const before = rows();
        assert.throws(() =>
          client.execute(
            [
              st(
                "UPDATE tasks SET title=CASE WHEN id=1 THEN 'ok' ELSE 'forbidden' END",
              ),
            ],
            mode,
          ),
        );
        assert.deepEqual(rows(), before);
        assert.equal(client.pending().length, 0);
        client.execute(
          [
            st(
              "INSERT INTO tasks(id,tenant,title,score,payload) VALUES(?,?,?,?,?)",
              [3n, "b", "offline", 1, new Uint8Array([0, 255])],
            ),
            st("INSERT INTO tags VALUES(3,'new')"),
          ],
          mode,
        );
        lose = true;
        await assert.rejects(client.sync(), /lost release ACK/);
        assert.equal(engine.revision(), 1);
        assert.equal(raw.all("SELECT count(*) AS n FROM audit")[0]!.n, 3n);
        await client.sync();
        assert.equal(engine.revision(), 1);
        assert.equal(client.pending().length, 0);
        client.execute([st("UPDATE tasks SET id=8 WHERE id=3")], mode);
        await client.sync();
        assert.equal(
          raw.all("SELECT task_id FROM tags WHERE tag='new'")[0]!.task_id,
          8n,
        );
        client.execute([st("DELETE FROM tasks WHERE id=8")], mode);
        await client.sync();
        assert.equal(
          raw.all("SELECT count(*) AS n FROM tags WHERE tag='new'")[0]!.n,
          0n,
        );
        for (const q of releaseObserve)
          assert.equal(
            typedRows(local.all(q.sql).map(Object.values)),
            typedRows(raw.all(q.sql).map(Object.values)),
            q.sql,
          );
        assert.equal(local.all("PRAGMA foreign_key_check").length, 0);
        assert.equal(
          raw.all("SELECT total FROM tenants WHERE tenant='b'")[0]!.total,
          0n,
        );
        const saved = localRaw.dump(),
          reopened = new MoonDatabase(saved);
        try {
          assert.equal(
            reopened.all("SELECT count(*) AS n FROM audit")[0]!.n,
            4n,
          );
        } finally {
          reopened.close();
        }
      } finally {
        localRaw.close();
        raw.close();
      }
    });
