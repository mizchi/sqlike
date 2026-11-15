import type { ImageStore } from "../src/ltx-transport.ts";
import { MAX_IMAGE } from "../src/ltx.ts";

/** Raw replicated bytes are separate from the VFS pool (which rewrites WAL headers). */
export class OpfsImages implements ImageStore {
  constructor(private directory: FileSystemDirectoryHandle) {}
  static async open(name: string): Promise<OpfsImages> {
    const root = await navigator.storage.getDirectory();
    return new OpfsImages(await root.getDirectoryHandle(`browser-litestream-${name}-ltx`, { create: true }));
  }
  private valid(name: string): void {
    if (!/^image-[0-9a-f-]{36}\.sqlite$/.test(name)) throw new Error("invalid OPFS image name");
  }
  async read(name: string): Promise<Uint8Array> {
    this.valid(name);
    const file = await (await this.directory.getFileHandle(name)).getFile();
    if (file.size > MAX_IMAGE) throw new Error("OPFS image exceeds 64 MiB");
    return new Uint8Array(await file.arrayBuffer());
  }
  async write(name: string, data: Uint8Array): Promise<void> {
    this.valid(name);
    if (data.length > MAX_IMAGE) throw new Error("OPFS image exceeds 64 MiB");
    const handle = await (await this.directory.getFileHandle(name, { create: true })).createSyncAccessHandle();
    try {
      handle.truncate(0);
      let offset = 0;
      while (offset < data.length) {
        const written = handle.write(data.subarray(offset), { at: offset });
        if (!written) throw new Error("OPFS image write made no progress");
        offset += written;
      }
      handle.flush();
    } finally { handle.close(); }
  }
  async prune(keep?: string): Promise<void> {
    for await (const [name] of this.directory.entries()) {
      if (name !== keep && /^image-[0-9a-f-]{36}\.sqlite$/.test(name)) await this.directory.removeEntry(name);
    }
  }
}
