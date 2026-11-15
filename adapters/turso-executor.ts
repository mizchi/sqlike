import { replyToDatabase, type DatabaseCommand } from "../src/database-rpc.ts";
import { packResult } from "../src/protocol.ts";
import { validateTursoBindings } from "./turso-bindings.ts";
import type { Value } from "../src/contract.ts";

let database: Awaited<
  ReturnType<typeof import("@tursodatabase/database-wasm").connect>
>;
let buffer: SharedArrayBuffer;
let serial = Promise.resolve();
self.onmessage = (
  event: MessageEvent<
    { name: string; buffer: SharedArrayBuffer } | DatabaseCommand
  >,
) => {
  const command = event.data;
  serial = serial.then(async () => {
    if ("name" in command) {
      try {
        buffer = command.buffer;
        self.postMessage({ progress: "loading-driver" });
        const { connect } = await import("@tursodatabase/database-wasm/bundle");
        self.postMessage({ progress: "opening-file" });
        database = await connect(command.name, {
          defaultQueryTimeout: 5000,
          experimental: ["without_rowid", "strict"],
        });
        self.postMessage({ ready: true });
      } catch (error) {
        self.postMessage({ error: String(error) });
      }
      return;
    }
    try {
      validateTursoBindings(command.params);
      const statement = await database.prepare(command.sql);
      try {
        const rows = await statement.safeIntegers(true).all(...command.params);
        replyToDatabase(buffer, {
          rows: rows.map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([name, value]) => [
                name,
                packResult(value as Value),
              ]),
            ),
          ),
        });
      } finally {
        statement.close();
      }
    } catch (error) {
      replyToDatabase(buffer, {
        error: error instanceof Error ? error.message : String(error),
        code:
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined,
      });
    }
  });
};
