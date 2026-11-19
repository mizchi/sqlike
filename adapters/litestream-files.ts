import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Read the replica's original bytes; validation of its LTX header belongs to the catalog. */
export async function readReplicaLtx(
  root: string,
  id: string,
): Promise<Buffer> {
  if (!/^[0-9]\/[0-9a-f]{16}-[0-9a-f]{16}\.ltx$/.test(id))
    throw new Error("invalid LTX file ID");
  const path = join(root, "ltx", id);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("LTX path is not a regular file");
  if (info.size > 64 * 1024 * 1024)
    throw new Error("LTX file exceeds 64 MiB limit");
  return readFile(path);
}
