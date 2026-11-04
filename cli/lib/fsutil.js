import { chmod, rename, writeFile } from "node:fs/promises";

export async function writeFileAtomic(path, data, { mode } = {}) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { encoding: "utf8", ...(mode ? { mode } : {}) });
  await rename(temp, path);
  // Windows maps chmod to the read-only bit only; this is best-effort there.
  if (mode) await chmod(path, mode).catch(() => {});
}
