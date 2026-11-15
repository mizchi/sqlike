import type { Database } from "../src/contract.ts";
import {
  AOT_LTX_MAX_BYTES,
  AOT_LTX_MAX_FILES,
  AotUploadError,
  ltxFilename,
  type AotLtxStore,
  type AotLtxGatewayState,
  type AotLtxReceipt,
} from "../src/aot-upload-contract.ts";

/** Platform-neutral SQL adapter: Node SQLite or DO SQL. Imported SQLite pages
 * are opaque 64 KiB BLOB chunks, never the DO's own database pages. */
export class SqlAotLtxStore implements AotLtxStore {
  constructor(
    private db: Database,
    private durable: () => Promise<void> = async () => {},
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS aot_ltx_state(id INTEGER PRIMARY KEY,body TEXT NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS aot_ltx_receipts(name TEXT PRIMARY KEY,txid TEXT UNIQUE NOT NULL,body TEXT NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS aot_ltx_chunks(key TEXT NOT NULL,pos INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(key,pos))",
    );
  }
  async state(): Promise<AotLtxGatewayState | undefined> {
    const body = this.db.all("SELECT body FROM aot_ltx_state WHERE id=1")[0]
      ?.body;
    return typeof body === "string" ? JSON.parse(body) : undefined;
  }
  async receipt(txid: string): Promise<AotLtxReceipt | undefined> {
    const body = this.db.all("SELECT body FROM aot_ltx_receipts WHERE txid=?", [
      txid,
    ])[0]?.body;
    return typeof body === "string" ? JSON.parse(body) : undefined;
  }
  async files(): Promise<AotLtxReceipt[]> {
    return this.db
      .all("SELECT body FROM aot_ltx_receipts ORDER BY name")
      .map((r) => JSON.parse(String(r.body)));
  }
  private bytes(key: string): Uint8Array {
    const rows = this.db.all(
      "SELECT pos,data FROM aot_ltx_chunks WHERE key=? ORDER BY pos",
      [key],
    );
    let size = 0;
    for (const [i, row] of rows.entries()) {
      if (
        row.pos !== BigInt(i) ||
        !(row.data instanceof Uint8Array) ||
        row.data.length > 65536 ||
        !row.data.length
      )
        throw Error("invalid stored LTX chunks");
      size += row.data.length;
      if (size > AOT_LTX_MAX_BYTES)
        throw Error("stored LTX exceeds size limit");
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const row of rows) {
      const data = row.data as Uint8Array;
      bytes.set(data, offset);
      offset += data.length;
    }
    return bytes;
  }
  async image() {
    return this.bytes("image");
  }
  async file(name: string) {
    return this.bytes(name);
  }
  async confirm() {
    await this.durable();
  }
  private put(key: string, data: Uint8Array) {
    this.db.run("DELETE FROM aot_ltx_chunks WHERE key=?", [key]);
    for (let pos = 0; pos * 65536 < data.length; pos++)
      this.db.run("INSERT INTO aot_ltx_chunks VALUES(?,?,?)", [
        key,
        BigInt(pos),
        data.slice(pos * 65536, (pos + 1) * 65536),
      ]);
  }
  async commit(
    expectedHead: string | undefined,
    state: AotLtxGatewayState,
    receipt: AotLtxReceipt,
    file: Uint8Array,
    image: Uint8Array,
  ): Promise<void> {
    this.db.transaction(() => {
      const body = this.db.all("SELECT body FROM aot_ltx_state WHERE id=1")[0]
        ?.body;
      const head =
        typeof body === "string"
          ? (JSON.parse(body) as AotLtxGatewayState).head
          : undefined;
      if (head !== expectedHead)
        throw new AotUploadError(
          409,
          "stale",
          "LTX gateway head changed; retry the same file",
        );
      const count = this.db.all(
        "SELECT count(*) AS n FROM aot_ltx_receipts",
      )[0]!.n;
      if (BigInt(count as bigint) >= BigInt(AOT_LTX_MAX_FILES))
        throw new AotUploadError(
          413,
          "files",
          "LTX history file limit reached",
        );
      const name = ltxFilename(receipt.upload.minTXID, receipt.upload.maxTXID);
      this.put(name, file);
      this.put("image", image);
      this.db.run("INSERT INTO aot_ltx_receipts VALUES(?,?,?)", [
        name,
        state.head,
        JSON.stringify(receipt),
      ]);
      this.db.run("INSERT OR REPLACE INTO aot_ltx_state VALUES(1,?)", [
        JSON.stringify(state),
      ]);
    });
    await this.confirm();
  }
}
