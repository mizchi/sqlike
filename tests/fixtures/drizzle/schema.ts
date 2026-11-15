import { sql } from "drizzle-orm";
import {
  sqliteTable,
  sqliteView,
  integer,
  real,
  text,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/sqlite-core";

/** Each transition is unambiguous to Kit; owner-written renames/triggers follow
 * the generated chain as normal custom migrations. */
export function schemaAt(version: number) {
  const users = sqliteTable(
    version >= 6 ? "members" : "users",
    {
      id: integer().primaryKey({ autoIncrement: true }),
      name: text(version >= 6 ? "display_name" : "name").notNull(),
      email: text().notNull(),
      score:
        version >= 3
          ? real().notNull().default(0.5)
          : integer().notNull().default(0),
      ...(version < 2 ? { legacy: text() } : {}),
      ...(version >= 1 && version < 5
        ? { bio: text().notNull().default("") }
        : {}),
    },
    (table) => [
      ...(version >= 1 ? [index("name_feed").on(table.name, table.id)] : []),
      ...(version >= 4
        ? [
            uniqueIndex("email_unique").on(table.email),
            check("valid_name", sql`length(${table.name})>0`),
          ]
        : []),
      ...(version >= 7
        ? [
            index("name_desc").on(sql`${table.name} DESC`, table.id),
            index("live_name")
              .on(sql`lower(${table.name})`)
              .where(sql`${table.score}>0`),
          ]
        : []),
    ],
  );
  const posts = sqliteTable("posts", {
    id: integer().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    title: text().notNull(),
  });
  if (version < 7) return { users, posts };
  const audit = sqliteTable("audit", {
    id: integer().primaryKey(),
    memberId: integer("member_id"),
    event: text(),
  });
  const memberNames = sqliteView("member_names").as((qb) =>
    qb.select({ id: users.id, display_name: users.name }).from(users),
  );
  return { users, posts, audit, memberNames };
}
