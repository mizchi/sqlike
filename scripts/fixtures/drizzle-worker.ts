import { DurableObject } from "cloudflare:workers";
import { DODatabase } from "../../adapters/do-database.ts";
import { drizzle } from "../../adapters/drizzle.ts";
import { migrate } from "../../adapters/drizzle-migrator.ts";
import { migrations } from "../../tests/fixtures/drizzle/migrations.generated.ts";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { eq, sql } from "drizzle-orm";
import { sha256 } from "../../src/aot-values.ts";
interface Env {
  ROOMS: DurableObjectNamespace<DrizzleRoom>;
}
const users = sqliteTable("members", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text("display_name").notNull(),
  email: text().notNull(),
});
export class DrizzleRoom extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    const client = new DODatabase(this.ctx.storage, {
        exclusive: (body) => this.ctx.blockConcurrencyWhile(body),
      }),
      db = drizzle(client);
    await migrate(db, migrations.slice(0, 1));
    client.run(
      "INSERT INTO users VALUES(1,'seed','seed@example.test',1,'old')",
    );
    client.run("INSERT INTO posts VALUES(7,1,'kept child')");
    for (let i = 1; i < migrations.length; i++)
      await migrate(db, migrations.slice(0, i + 1));
    const rerun = await migrate(db, migrations);
    const inserted = db
      .insert(users)
      .values({ name: "one", email: "one@example.test" })
      .returning()
      .get();
    const updated = db
      .update(users)
      .set({ name: "updated" })
      .where(eq(users.id, 2))
      .returning({
        id: users.id,
        upper: sql<string>`upper(${users.name})`.mapWith(String),
      })
      .get();
    db.transaction((tx) => {
      try {
        tx.transaction((nested) => {
          nested
            .insert(users)
            .values({ name: "rollback", email: "rollback@example.test" })
            .run();
          nested.rollback();
        });
      } catch {}
    });
    const badSql = [
      "PRAGMA foreign_keys=OFF;",
      "CREATE TABLE rollback_schema(n INTEGER);",
      "INSERT INTO posts VALUES(9,999,'orphan');",
      "PRAGMA foreign_keys=ON;",
    ];
    const bad = {
      sql: badSql,
      hash: await sha256(badSql.join("--> statement-breakpoint")),
      folderMillis: migrations.at(-1)!.folderMillis + 1,
      bps: true,
    };
    let failedError = "",
      unsafeError = "";
    try {
      await migrate(db, [...migrations, bad]);
    } catch (e) {
      failedError = (e as Error).message;
    }
    try {
      await migrate(drizzle(new DODatabase(this.ctx.storage)), [
        ...migrations,
        bad,
      ]);
    } catch (e) {
      unsafeError = (e as Error).message;
    }
    return new Response(
      JSON.stringify(
        {
          inserted,
          updated,
          rows: db.select().from(users).orderBy(users.id).all(),
          rerun,
          failedError,
          unsafeError,
          rollbackSchema: client.values(
            "SELECT name FROM sqlite_schema WHERE name='rollback_schema'",
          ),
          children: client.values("SELECT * FROM posts"),
          fk: client.values("PRAGMA foreign_key_check"),
          mode: client.values("PRAGMA foreign_keys"),
          audit: client.values("SELECT member_id,event FROM audit"),
          log: client.values("SELECT count(*) FROM __drizzle_migrations"),
        },
        (_, v) => (typeof v === "bigint" ? String(v) : v),
      ),
      { headers: { "content-type": "application/json" } },
    );
  }
}
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.ROOMS.get(
      env.ROOMS.idFromName(new URL(request.url).search),
    ).fetch(request);
  },
};
