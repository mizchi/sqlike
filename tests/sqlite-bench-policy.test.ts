import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparisonOptions,
  comparisonSampling,
  boundComparisonIterations,
  calibratedComparisonIterations,
  comparisonDecodeWork,
} from "../scripts/sqlite-bench-policy.ts";

test("normal SQLite comparisons retain their datasets and sampling", () => {
  const options = comparisonOptions([]);
  assert.deepEqual(options.datasets, [[100, 0], [1000, 0], [5000, 0], [100, 5000]]);
  assert.equal(options.output, "measurements/sqlite-speed-current.json");
  const sampling = comparisonSampling(5000, false);
  assert.equal(sampling.runs, 7);
  assert.equal(sampling.targetMilliseconds, 50);
  assert.equal(boundComparisonIterations(0, 5000, sampling), 5);
  assert.deepEqual(comparisonDecodeWork(3, 5000, sampling), { iterations: 50, warmup: 100 });
});

test("100k datasets use separate reports and skip the unrelated small-table diagnostic", () => {
  const options = comparisonOptions(["--prepared", "--rows=100000", "--profiles=false"]);
  assert.deepEqual(options.datasets, [[100000, 0]]);
  assert.equal(options.output, "measurements/dynamic-prepare-large-current.json");
  assert.equal(options.profiles, false);
  assert.equal(comparisonOptions(["--rows=100000"]).output, "measurements/sqlite-large-current.json");
  assert.equal(comparisonOptions(["--rows=100000", "--output=/tmp/large.json"]).output, "/tmp/large.json");
  assert.deepEqual(comparisonOptions(["--smoke", "--rows=100000"]).datasets, [[100000, 0]]);
  for (const rows of ["0", "99", "100001", "1000000", "100,100"])
    assert.throws(() => comparisonOptions([`--rows=${rows}`]), /rows/);
  assert.throws(() => comparisonOptions(["--mystery"]), /unknown option/);
});

test("large full scans and decode probes cannot inherit the five/fifty/hundred-iteration floors", () => {
  const sampling = comparisonSampling(100000, false);
  assert.equal(sampling.runs, 3);
  assert.equal(sampling.targetMilliseconds, 20);
  assert.equal(boundComparisonIterations(1000000, 100000, sampling), 2);
  assert.equal(calibratedComparisonIterations(2, 1000, 100000, sampling), 1);
  assert.equal(calibratedComparisonIterations(1, 0, 100000, sampling), 2);
  assert.deepEqual(comparisonDecodeWork(3, 100000, sampling), { iterations: 2, warmup: 1 });
  assert.equal(calibratedComparisonIterations(100, 1, 1, sampling), 2000);
  assert.ok(sampling.datasetTimeoutMilliseconds <= 180000);
});

test("smoke sampling accepts large rows while retaining bounded scan work", () => {
  const sampling = comparisonSampling(100000, true);
  assert.equal(sampling.runs, 1);
  assert.equal(sampling.calibrationRounds, 0);
  assert.equal(boundComparisonIterations(5, 100000, sampling), 2);
  assert.deepEqual(comparisonDecodeWork(5, 100000, sampling), { iterations: 2, warmup: 1 });
});
