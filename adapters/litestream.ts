import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { NodeDatabase } from "./node-database.ts";
import { SyncEngine } from "../src/engine.ts";
import type { Snapshot } from "../src/contract.ts";
import type { LtxCatalog, LtxCatalogFile } from "../src/ltx-contract.ts";

const execute = promisify(execFile);

/** The direct path serves original LTX bytes; only the legacy path runs restore. */
export class LitestreamReplica {
  private process: ChildProcess;
  private configDir: string;
  private replica: string;
  private failure = "";
  private socket: string;
  readonly epoch: string;
  constructor(private binary: string, private database: string, private root: string) {
    this.configDir = mkdtempSync(join(tmpdir(), "browser-litestream-config-"));
    this.replica = pathToFileURL(resolve(root)).href;
    mkdirSync(root, { recursive: true });
    this.socket = join(this.configDir, "control.sock");
    const identityPath = join(root, ".browser-litestream-epoch.json");
    const stat = statSync(database); const source = `${stat.dev}:${stat.ino}`;
    let identity: { epoch: string; source: string } | undefined;
    try { identity = JSON.parse(readFileSync(identityPath, "utf8")); } catch { /* first start */ }
    if (!identity || identity.source !== source) {
      identity = { epoch: randomUUID(), source };
      writeFileSync(identityPath, JSON.stringify(identity));
    }
    this.epoch = identity.epoch;
    const config = join(this.configDir, "litestream.yml");
    writeFileSync(config, `socket:\n  enabled: true\n  path: ${JSON.stringify(this.socket)}\ndbs:\n  - path: ${JSON.stringify(resolve(database))}\n    replica:\n      url: ${JSON.stringify(this.replica)}\n      sync-interval: 100ms\n`);
    this.process = spawn(binary, ["replicate", "-config", config], { stdio: ["ignore", "ignore", "pipe"] });
    this.process.stderr?.on("data", data => { this.failure = String(data).slice(-2000); });
    this.process.on("error", error => { this.failure = error.message; });
  }
  async catalog(minRevision: number): Promise<LtxCatalog> {
    // A sync barrier ensures the catalog includes the operations already ACKed.
    let synced = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (this.process.exitCode !== null || this.process.signalCode !== null) throw new Error(`Litestream exited: ${this.failure}`);
      try {
        await execute(this.binary, ["sync", "-socket", this.socket, "-wait", "-timeout", "10", resolve(this.database)], { timeout: 15000 });
        synced = true; break;
      } catch (e) { this.failure = String(e); await delay(100); }
    }
    if (!synced) throw new Error(`Litestream sync barrier failed: ${this.failure}`);
    const files: LtxCatalogFile[] = [];
    const levels = await readdir(join(this.root, "ltx"));
    for (const level of levels.filter(x => /^[0-9]$/.test(x))) {
      for (const name of await readdir(join(this.root, "ltx", level))) {
        if (!/^[0-9a-f]{16}-[0-9a-f]{16}\.ltx$/.test(name)) continue;
        const id = `${level}/${name}`;
        try {
          const bytes = await this.file(id);
          if (bytes.length < 100 || bytes.subarray(0, 4).toString() !== "LTX1") throw new Error("invalid replica LTX header");
          const min = bytes.readBigUInt64BE(16); const max = bytes.readBigUInt64BE(24);
          if (min !== BigInt(`0x${name.slice(0, 16)}`) || max !== BigInt(`0x${name.slice(17, 33)}`)) throw new Error("replica filename/header mismatch");
          files.push({ id, minTXID: String(min), maxTXID: String(max), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
    }
    const targetTXID = files.reduce((max, file) => BigInt(file.maxTXID) > BigInt(max) ? file.maxTXID : max, "0");
    if (!files.length) throw new Error("replica has no snapshot");
    return { format: 3, epoch: this.epoch, minRevision, targetTXID, files };
  }
  async file(id: string): Promise<Buffer> {
    if (!/^[0-9]\/[0-9a-f]{16}-[0-9a-f]{16}\.ltx$/.test(id)) throw new Error("invalid LTX file ID");
    const path = join(this.root, "ltx", id);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("LTX file exceeds 64 MiB limit");
    return readFile(path);
  }
  async snapshot(minRevision: number): Promise<Snapshot> {
    const dir = mkdtempSync(join(tmpdir(), "browser-litestream-restore-"));
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (this.process.exitCode !== null || this.process.signalCode !== null) throw new Error(`Litestream exited: ${this.failure}`);
        const path = join(dir, `snapshot-${attempt}.sqlite`);
        try {
          await execute(this.binary, ["restore", "-o", path, this.replica], { timeout: 10000 });
          const db = new NodeDatabase(path, false, true);
          try {
            const snapshot = new SyncEngine(db, false).snapshot();
            if (snapshot.revision >= minRevision) return snapshot;
          } finally { db.close(); }
        } catch (e) { this.failure = e instanceof Error ? e.message : String(e); }
        await delay(100);
      }
      throw new Error(`Litestream replica has not reached revision ${minRevision}: ${this.failure}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  async close(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill("SIGTERM");
      await new Promise<void>(resolve => this.process.once("exit", () => resolve()));
    }
    rmSync(this.configDir, { recursive: true, force: true });
  }
}
