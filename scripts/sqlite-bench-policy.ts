/** Benchmark-only scheduling. Large datasets stay opt-in and use separate reports. */
export function comparisonOptions(args: string[]) {
  for (const arg of args)
    if (!/^(--smoke|--prepared|--output=.+|--rows=\d+(,\d+)*|--profiles=false|--profile-queries=[a-z,]+|--profile-engines=[a-z,]+)$/.test(arg))
      throw Error(`unknown option ${arg}`);
  const smoke = args.includes("--smoke"), prepared = args.includes("--prepared");
  const rowCounts = (args.find(a => a.startsWith("--rows="))?.slice(7) ??
    (smoke ? "100" : "100,1000,5000")).split(",").map(Number);
  if (!rowCounts.every(n => Number.isSafeInteger(n) && n >= 100 && n <= 100000 && n % 100 === 0) ||
      new Set(rowCounts).size !== rowCounts.length)
    throw Error("rows must be distinct multiples of 100 in 100..100000");
  const largeOnly = rowCounts.every(n => n > 10000);
  const large = rowCounts.some(n => n > 10000);
  const report = prepared ? "dynamic-prepare" : large ? "sqlite" : "sqlite-speed";
  return {
    smoke, prepared, rowCounts,
    profiles: !smoke && !args.includes("--profiles=false"),
    output: args.find(a => a.startsWith("--output="))?.slice(9) ??
      (smoke ? "/tmp/browser-litestream-sqlite-smoke.json" :
        `measurements/${report}${large ? "-large" : ""}-current.json`),
    datasets: [
      ...rowCounts.map(n => [n, 0] as const),
      ...(smoke || largeOnly ? [] : [[100, 5000] as const]),
    ],
  };
}

export interface ComparisonSampling {
  runs: number;
  targetMilliseconds: number;
  calibrationRounds: number;
  minIterations: number;
  maxIterations: number;
  maxResultRowsPerSample: number | null;
  warmupLimit: number;
  datasetTimeoutMilliseconds: number;
}

export function comparisonSampling(rows: number, smoke: boolean): ComparisonSampling {
  const large = rows > 10000;
  return {
    runs: smoke ? 1 : large ? 3 : 7,
    targetMilliseconds: large ? 20 : 50,
    calibrationRounds: smoke ? 0 : 2,
    minIterations: large ? 1 : 5,
    maxIterations: 1000000,
    maxResultRowsPerSample: large ? 200000 : null,
    warmupLimit: smoke ? 1 : large ? 2 : 200,
    datasetTimeoutMilliseconds: large ? 120000 : 180000,
  };
}

export function boundComparisonIterations(requested: number, resultRows: number, sampling: ComparisonSampling) {
  const rowLimit = sampling.maxResultRowsPerSample === null || resultRows === 0
    ? sampling.maxIterations
    : Math.max(1, Math.floor(sampling.maxResultRowsPerSample / resultRows));
  return Math.max(sampling.minIterations, Math.min(sampling.maxIterations, rowLimit, Math.ceil(requested)));
}

export function calibratedComparisonIterations(iterations: number, elapsedMilliseconds: number,
  resultRows: number, sampling: ComparisonSampling) {
  return boundComparisonIterations(iterations * sampling.targetMilliseconds /
    Math.max(0.05, elapsedMilliseconds), resultRows, sampling);
}

export function comparisonDecodeWork(iterations: number, resultRows: number, sampling: ComparisonSampling) {
  return sampling.maxResultRowsPerSample === null
    ? { iterations: Math.max(50, iterations), warmup: 100 }
    : { iterations: boundComparisonIterations(iterations, resultRows, sampling), warmup: 1 };
}
