import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generatedOutputPolicyCases,
  outputPolicySeeds,
} from "./compatibility/output-generated-corpus.ts";
test("generated output corpus is reproducible, seed-sensitive and covers all required families", () => {
  const encode = (v: unknown) =>
    JSON.stringify(v, (_, x) =>
      typeof x === "bigint"
        ? String(x) + "n"
        : x instanceof Uint8Array
          ? Array.from(x)
          : x,
    );
  const a = generatedOutputPolicyCases(outputPolicySeeds[0]!);
  assert.equal(
    encode(a),
    encode(generatedOutputPolicyCases(outputPolicySeeds[0]!)),
  );
  assert.notEqual(
    encode(a),
    encode(generatedOutputPolicyCases(outputPolicySeeds[1]!)),
  );
  assert.equal(new Set(a.map((c) => c.id)).size, a.length);
  assert.equal(new Set(a.map((c) => c.family)).size, 10);
  assert.ok(
    a.some((c) => c.family === "extremum-representative" && c.mustSucceed),
  );
  assert.ok(a.some((c) => c.mustReject));
  assert.ok(a.some((c) => c.mustSucceed));
  assert.ok(a.some((c) => c.nativeError));
});
