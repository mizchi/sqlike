import type { BrowserDatabase } from "../src/backend-contract.ts";
import { validateTursoBindings } from "./turso-bindings.ts";
import type { Value } from "../src/contract.ts";
import { DatabaseBridge, RPC_HEADER } from "../src/database-rpc.ts";
import { MAX_RESPONSE } from "../src/http.ts";
import { SyncFailure } from "../src/errors.ts";
import { readOnly } from "../src/safety.ts";
import { packStored } from "../src/protocol.ts";

/** Keep synchronous engine/policy contracts while Turso's driver awaits OPFS I/O. */
export class TursoDatabase implements BrowserDatabase {
  private constructor(private bridge: DatabaseBridge) {}
  static async open(name: string): Promise<TursoDatabase> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      throw new Error("invalid Turso database name");
    if (
      !globalThis.crossOriginIsolated ||
      typeof SharedArrayBuffer === "undefined"
    )
      throw new Error("Turso requires COOP/COEP headers and SharedArrayBuffer");
    if (typeof document !== "undefined")
      throw new Error("Turso's sync adapter must run in a dedicated Worker");
    const worker = new Worker(new URL("./turso-executor.ts", import.meta.url), {
      type: "module",
    });
    const buffer = new SharedArrayBuffer(RPC_HEADER + MAX_RESPONSE);
    try {
      await new Promise<void>((resolve, reject) => {
        let phase = "starting-worker";
        const timer = setTimeout(
          () => reject(new Error(`Turso initialization timeout (${phase})`)),
          20000,
        );
        worker.onmessage = (event) => {
          if (event.data.progress) {
            phase = event.data.progress;
            return;
          }
          clearTimeout(timer);
          event.data.ready
            ? resolve()
            : reject(
                new Error(event.data.error ?? "Turso initialization failed"),
              );
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.postMessage({
          name: `browser-litestream-turso-${name}.sqlite`,
          buffer,
        });
      });
      return new TursoDatabase(
        new DatabaseBridge(
          buffer,
          (command) => worker.postMessage(command),
          () => worker.terminate(),
        ),
      );
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }
  all(sql: string, params: Value[] = []): Record<string, Value>[] {
    validateTursoBindings(params);
    return this.bridge.all(sql, params);
  }
  run(sql: string, params: Value[] = []): void {
    this.all(sql, params);
  }
  schemaVersion(): number {
    return Number(Object.values(this.all("PRAGMA schema_version")[0]!)[0]);
  }
  transaction<T>(body: () => T): T {
    this.run("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.run("COMMIT");
      return result;
    } catch (error) {
      try {
        this.run("ROLLBACK");
      } catch {
        this.bridge.close();
        throw new SyncFailure({
          kind: "transport",
          code: "storage-rollback",
          message:
            "rollback could not be confirmed; reload to recover the transaction outcome",
          disposition: "defer",
          retryable: false,
        });
      }
      throw error;
    }
  }
  query(sql: string, params: Value[] = []): Record<string, Value>[] {
    return readOnly(this)({ sql, params: params.map(packStored) });
  }
}
