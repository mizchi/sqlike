import { DurableObject } from "cloudflare:workers";
import { DODatabase } from "../../adapters/do-database.ts";
interface Env {
  ROOMS: DurableObjectNamespace<BenchRoom>;
}
export class BenchRoom extends DurableObject<Env> {
  async fetch(request: Request) {
    const { packResult } = await import("../../src/protocol.ts");
    const { engine, query, iterations } = await request.json<{
      engine: "raw" | "typed";
      query: "point" | "real" | "update" | "cte" | "returning";
      iterations: number;
    }>();
    if (
      !["raw", "typed"].includes(engine) ||
      !["point", "real", "update", "cte", "returning"].includes(query) ||
      !Number.isInteger(iterations) ||
      iterations < 1 ||
      iterations > 10000
    )
      return new Response("invalid probe", { status: 400 });
    const s = this.ctx.storage;
    s.sql.exec(
      "CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY,n INTEGER)",
    );
    if (s.sql.exec("SELECT count(*) AS n FROM t").one().n === 0)
      s.transactionSync(() => {
        for (let i = 1; i <= 1000; i++)
          s.sql.exec("INSERT INTO t VALUES(?,?)", i, i * 3);
      });
    let calls = 0;
    const db = new DODatabase({
      transactionSync: (body) => s.transactionSync(body),
      sql: {
        exec: (sql, ...values) => {
          calls++;
          return s.sql.exec(sql, ...values);
        },
      },
    });
    const sql =
      query === "point"
        ? "SELECT id,n FROM t WHERE id=?"
        : query === "real"
          ? "SELECT ? AS v,typeof(?) AS t"
          : query === "cte"
            ? "WITH selected AS (SELECT id,n FROM t WHERE id=?) SELECT id,n FROM selected"
            : query === "returning"
              ? "UPDATE t SET n=? WHERE id=? RETURNING id,n"
              : "UPDATE t SET n=? WHERE id=?";
    const params =
      query === "point" || query === "cte"
        ? [500n]
        : query === "real"
          ? [1.5, 1.5]
          : [1500n, 500n];
    let rows: unknown = [];
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      if (engine === "typed")
        rows = db
          .all(sql, params)
          .map((r) =>
            Object.fromEntries(
              Object.entries(r).map(([k, v]) => [k, packResult(v)]),
            ),
          );
      else {
        calls++;
        rows = s.sql
          .exec(
            sql,
            ...params.map((v) => (typeof v === "bigint" ? Number(v) : v)),
          )
          .toArray();
      }
    }
    return Response.json({
      milliseconds: performance.now() - start,
      calls,
      rows,
    });
  }
}
export default {
  fetch(request: Request, env: Env) {
    return env.ROOMS.get(env.ROOMS.idFromName("benchmark")).fetch(request);
  },
};
