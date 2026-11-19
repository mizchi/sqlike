import { updateFrom } from "../src/sqlike-features.ts";
import { measureOptionalFeature } from "./measure-optional-feature.ts";

await measureOptionalFeature({
  id: "update-from", feature: updateFrom, runner: "scripts/measure-update-from.ts",
  catalog: {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INTEGER)", "CREATE TABLE s(id INTEGER PRIMARY KEY,n INTEGER)"],
    queries: [{ name: "q", sql: "UPDATE t SET n=s.n FROM s WHERE t.id=s.id RETURNING id,n" }],
  },
  expected: [],
});
