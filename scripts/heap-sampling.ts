export interface HeapUsage {
  usedSize: number;
  backingStorageSize: number;
}
/** Separate, instrumented workload. This observes samples, not an exact transient
 * high-water mark, live heap after GC, process RSS or IndexedDB service memory. */
export async function sampleHeapDuring<T>(
  action: () => Promise<T>,
  read: () => Promise<HeapUsage>,
  intervalMs = 2,
) {
  const samples = [{ milliseconds: 0, ...(await read()) }],
    started = performance.now();
  let done = false;
  const outcome = Promise.resolve()
    .then(action)
    .then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    )
    .finally(() => {
      done = true;
    });
  try {
    while (!done) {
      await new Promise((r) => setTimeout(r, intervalMs));
      samples.push({
        milliseconds: performance.now() - started,
        ...(await read()),
      });
    }
  } catch (error) {
    await outcome;
    throw error;
  }
  const result = await outcome;
  if (!result.ok) throw result.error;
  return {
    value: result.value,
    samples,
    peak: {
      usedSize: Math.max(...samples.map((s) => s.usedSize)),
      backingStorageSize: Math.max(...samples.map((s) => s.backingStorageSize)),
      combinedBytes: Math.max(
        ...samples.map((s) => s.usedSize + s.backingStorageSize),
      ),
    },
  };
}
