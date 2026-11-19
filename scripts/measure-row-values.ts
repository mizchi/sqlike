import { rowValues } from "../src/sqlike-features.ts";
import { measureOptionalFeature } from "./measure-optional-feature.ts";

await measureOptionalFeature({
  id: "row-values", feature: rowValues, runner: "scripts/measure-row-values.ts",
  catalog: { schema: [], queries: [{ name: "q", sql: "SELECT (1,2)<(2,0),(1,NULL)=(1,NULL),(1,2) IN ((1,2))" }] },
  expected: [[1n,null,1n]],
});
