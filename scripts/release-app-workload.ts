import { AotDatabase } from "../adapters/aot-database.ts";
import { MoonImageStore } from "../adapters/moon-image-store.ts";
import { aotBindings } from "../src/aot-values.ts";
class App {
  writes = 0;
  constructor(
    private db: AotDatabase,
    private artifact: string,
    private hash: string,
    private name: string,
  ) {}
  async read(runs = 7, iterations = 200) {
    const samples = [];
    for (let run = 0; run < runs; run++) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) await this.db.inspect("get", [1n]);
      samples.push((performance.now() - start) / iterations);
    }
    return samples;
  }
  async write(runs = 7, iterations = 50) {
    const samples = [];
    for (let run = 0; run < runs; run++) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        await this.db.execute("rename", [`changed-${this.writes % 2}`, 1n]);
        this.writes++;
      }
      samples.push((performance.now() - start) / iterations);
    }
    return samples;
  }
  async verify() {
    await this.db.close();
    this.db = await AotDatabase.withStore(
      this.artifact,
      this.hash,
      await MoonImageStore.open(this.name),
    );
    return {
      writes: this.writes,
      rows: [
        (await this.db.inspect("get", [1n])).rows,
        (await this.db.inspect("audit")).rows,
        (await this.db.inspect("totals")).rows,
      ].map((rows) => rows.map((row) => JSON.parse(aotBindings(row)))),
    };
  }
  close() {
    return this.db.close();
  }
}
export async function setup(fixtureURL: string, name: string) {
  const f = (await (await fetch(fixtureURL)).json()) as {
    artifact: string;
    hash: string;
  };
  const db = await AotDatabase.withStore(
    f.artifact,
    f.hash,
    await MoonImageStore.open(name),
  );
  await db.execute("tenant");
  for (let i = 1; i <= 100; i++)
    await db.execute("add", [
      BigInt(i),
      `row${i}`,
      1,
      new Uint8Array(64).fill(i & 255),
    ]);
  window.releaseApp = new App(db, f.artifact, f.hash, name);
}
declare global {
  interface Window {
    releaseApp: App;
  }
}
