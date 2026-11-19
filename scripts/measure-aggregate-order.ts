import { aggregateOrderBy } from "../src/sqlike-features.ts";
import { measureOptionalFeature } from "./measure-optional-feature.ts";

await measureOptionalFeature({
  id: "aggregate-order", feature: aggregateOrderBy, runner: "scripts/measure-aggregate-order.ts",
  catalog: { schema: [], queries: [{ name: "q", sql: "SELECT group_concat(x ORDER BY x DESC) FROM (SELECT 'a' AS x UNION ALL SELECT 'b')" }] },
  expected: [["b,a"]],
});
