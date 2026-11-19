import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
export async function createBuildStage(destination: string) {
  const path = resolve(destination);
  if (path === dirname(path) || path === process.cwd())
    throw Error("build output must be a dedicated directory");
  await mkdir(dirname(path), { recursive: true });
  return mkdtemp(join(dirname(path), `.${basename(path)}-stage-`));
}
/** Handled errors preserve the old output. This is not a crash-durable rename protocol. */
export async function publishBuildStage(stage: string, destination: string) {
  const backup = join(
    dirname(destination),
    `.${basename(destination)}-old-${randomUUID()}`,
  );
  let moved = false;
  try {
    await rename(destination, backup);
    moved = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await rename(stage, destination);
  } catch (e) {
    if (moved) await rename(backup, destination);
    throw e;
  }
  if (moved) await rm(backup, { recursive: true, force: true });
}
export async function withBuildStage<T>(
  destination: string,
  build: (stage: string) => Promise<T>,
): Promise<T> {
  destination = resolve(destination);
  const stage = await createBuildStage(destination);
  try {
    const result = await build(stage);
    await publishBuildStage(stage, destination);
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
