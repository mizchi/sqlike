import { MoonDatabase } from "../../adapters/moon-database.ts";
import { drizzle } from "../../adapters/drizzle.ts";
import { migrate } from "../../adapters/drizzle-migrator.ts";
import { migrations } from "../../tests/fixtures/drizzle/migrations.generated.ts";
import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";
import { eq, sql } from "drizzle-orm";

const members = sqliteTable("members", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text("display_name").notNull(),
  email: text().notNull(),
  score: real(),
});
async function run(reopen: boolean) {
  let client = await MoonDatabase.open("drizzle-browser");
  try {
    if (reopen) {
      const result = await migrate(drizzle(client), migrations);
      return {
        ...result,
        rows: drizzle(client)
          .select({ id: members.id, name: members.name, score: members.score })
          .from(members)
          .orderBy(members.id)
          .all(),
        children: client.values("SELECT * FROM posts ORDER BY id"),
        audit: client.values("SELECT member_id,event FROM audit"),
        log: client.values("SELECT count(*) FROM __drizzle_migrations"),
        fk: client.values("PRAGMA foreign_key_check"),
      };
    }
    for (let i = 0; i < migrations.length; i++) {
      await migrate(drizzle(client), migrations.slice(0, i + 1));
      if (i === 0) {
        client.run(
          "INSERT INTO users VALUES(1,'one','one@example.test',2,'old')",
        );
        client.run("INSERT INTO posts VALUES(7,1,'kept child')");
      }
      client.close();
      client = await MoonDatabase.open("drizzle-browser");
    }
    const db = drizzle(client);
    const inserted = db
      .insert(members)
      .values({ name: "two", email: "two@example.test", score: 1.5 })
      .returning()
      .get();
    const updated = db
      .update(members)
      .set({ score: sql`${members.score}+1` })
      .where(eq(members.id, 2))
      .returning({
        id: members.id,
        name: sql<string>`upper(${members.name})`.mapWith(String),
        score: members.score,
      })
      .get();
    const deleted = db
      .delete(members)
      .where(eq(members.id, 2))
      .returning({ id: members.id })
      .all();
    try {
      db.transaction((tx) => {
        tx.insert(members)
          .values({ name: "rollback", email: "rollback@example.test" })
          .run();
        throw Error("rollback");
      });
    } catch {}
    return {
      inserted,
      updated,
      deleted,
      rows: db
        .select({ id: members.id, name: members.name, score: members.score })
        .from(members)
        .all(),
      children: client.values("SELECT * FROM posts"),
      fk: client.values("PRAGMA foreign_key_check"),
    };
  } finally {
    client.close();
  }
}
self.onmessage = (event: MessageEvent<{ reopen: boolean }>) => {
  run(event.data.reopen).then(
    (result) => self.postMessage({ result }),
    (error) => self.postMessage({ error: error.stack ?? error.message }),
  );
};
