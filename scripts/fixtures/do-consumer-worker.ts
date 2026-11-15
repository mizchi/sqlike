import { DurableObject } from "cloudflare:workers";
import { DODatabase } from "../../adapters/do-database.ts";
import { doConsumerCases } from "../../tests/compatibility/do-consumer-cases.ts";
interface Env {
  ROOMS: DurableObjectNamespace<ConsumerRoom>;
}
export class ConsumerRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const scenario = doConsumerCases.find(
      (s) => new URL(request.url).pathname === `/${s.id}`,
    );
    if (!scenario) return new Response("not found", { status: 404 });
    const { packResult } = await import("../../src/protocol.ts");
    const db = new DODatabase(this.ctx.storage);
    // Fixture bootstrap is trusted native SQL; this does not expand the public
    // adapter's trigger/multiple-statement permissions.
    for (const sql of scenario.schema) this.ctx.storage.sql.exec(sql);
    const initialTotalChanges = String(
      this.ctx.storage.sql
        .exec("SELECT CAST(total_changes() AS TEXT) AS n")
        .toArray()[0]!.n,
    );
    const packed = (rows: ReturnType<DODatabase["all"]>) =>
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, packResult(value)]),
        ),
      );
    const results = scenario.steps.map((step) => {
      let rows: ReturnType<typeof packed> = [],
        error = "";
      try {
        rows = packed(db.all(step.sql, step.params));
      } catch (e) {
        error = (e as Error).message;
      }
      return {
        rows,
        error,
        notes: packed(db.all("SELECT * FROM notes ORDER BY id")),
        ...(scenario.id === "cte-application-dml"
          ? { audit: packed(db.all("SELECT * FROM audit ORDER BY id")) }
          : {}),
      };
    });
    let sqlite = "unavailable",
      sqliteVersionError: string | undefined;
    try {
      sqlite = String(
        this.ctx.storage.sql
          .exec("SELECT sqlite_version() AS version")
          .toArray()[0]!.version,
      );
    } catch (e) {
      sqliteVersionError = (e as Error).message;
    }
    return Response.json({
      id: scenario.id,
      sqlite,
      sqliteVersionError,
      initialTotalChanges,
      results,
    });
  }
}
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    return env.ROOMS.get(env.ROOMS.idFromName(url.pathname + url.search)).fetch(
      request,
    );
  },
};
