import { AotDatabase } from "../adapters/aot-database.ts";
import { artifact, manifest } from "../examples/notes/program.generated.ts";
import type { Value } from "./contract.ts";
import { syncAotLtx } from "./aot-upload.ts";
const scope = self as unknown as DedicatedWorkerGlobalScope;
let database: AotDatabase | undefined;
scope.onmessage = async (
  event: MessageEvent<{ id: number; method: string; args: unknown[] }>,
) => {
  const { id, method, args } = event.data;
  try {
    let result: unknown;
    if (method === "init") {
      if (database) throw Error("database is already initialized");
      database = await AotDatabase.open(
        String(args[0]),
        artifact,
        manifest.artifactSHA256,
      );
      result = await database.inspect("list");
    } else {
      if (!database) throw Error("database is initializing");
      switch (method) {
        case "execute":
          result = await database.execute(
            String(args[0]),
            (args[1] ?? []) as Value[],
          );
          break;
        case "state":
          result = await database.inspect("list");
          break;
        case "checkpoint":
          result = await database.checkpoint();
          break;
        case "pending":
          result = await database.pending();
          break;
        case "sync": {
          const synced = await syncAotLtx(database, String(args[0]));
          result = {
            uploaded: synced.uploaded,
            ...(synced.checkpoint.deferred
              ? { deferred: synced.checkpoint.deferred }
              : {}),
          };
          break;
        }
        case "acknowledge":
          result = await database.acknowledge(String(args[0]), String(args[1]));
          break;
        case "exportSQLite":
          result = await database.exportSQLite();
          break;
        case "close":
          result = await database.close();
          break;
        default:
          throw Error("unknown AOT worker method");
      }
    }
    scope.postMessage({ id, result });
  } catch (error) {
    scope.postMessage({ id, error: (error as Error).message });
  }
};
