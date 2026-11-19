import { generatedColumns } from "../src/sqlike-features.ts";
import { measureOptionalFeature } from "./measure-optional-feature.ts";

await measureOptionalFeature({
  id: "generated-columns", feature: generatedColumns, runner: "scripts/measure-generated-columns.ts",
  catalog: {
    schema: ["CREATE TABLE t(id INTEGER PRIMARY KEY,n INT,v INT AS(n*2))"],
    queries: [{name:"q",sql:"INSERT INTO t VALUES(1,3) RETURNING id,n,v"}],
  },
  expected: [[1n,3n,6n]],
});
