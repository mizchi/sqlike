import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeProfile } from "../scripts/profile-summary.ts";

test("CPU profile uses sample durations and attributes inclusive time without double counting categories", () => {
  const summary = summarizeProfile({
    nodes: [
      { id: 1, callFrame: { functionName: "(root)" }, children: [2, 4] },
      { id: 2, callFrame: { functionName: "row__environment" }, children: [3] },
      { id: 3, callFrame: { functionName: "find__binding" } },
      { id: 4, callFrame: { functionName: "_M0FPC14json_stringify" } },
    ],
    samples: [3, 3, 2, 4],
    timeDeltas: [1000, 2000, 3000, 4000],
  });
  assert.equal(summary.sampledMs, 10);
  assert.equal(
    summary.topFunctions.find((f) => f.name === "row__environment")!
      .inclusiveMs,
    6,
  );
  assert.equal(
    summary.topFunctions.find((f) => f.name === "row__environment")!.selfMs,
    3,
  );
  assert.deepEqual(
    Object.fromEntries(summary.categories.map((c) => [c.name, c.milliseconds])),
    {
      JSON: 4,
      "row environments": 3,
      "column resolution": 3,
    },
  );
  assert.equal(
    summary.categories.reduce((n, c) => n + c.milliseconds, 0),
    10,
  );
});
