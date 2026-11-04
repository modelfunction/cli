import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeTool } from "./scan.js";

export async function loadAdapterTools(filePath) {
  const abs = resolve(filePath);
  let mod;
  try {
    mod = await import(`${pathToFileURL(abs).href}?t=${Date.now()}`);
  } catch (error) {
    throw new Error(`adapter import failed (${abs}): ${error.message}`);
  }

  const raw = mod.default ?? mod.tools ?? mod.functions;
  if (!Array.isArray(raw)) {
    throw new Error(`${abs}: 需要 export default [...] 或 export const tools = [...]`);
  }

  const tools = raw.map(normalizeTool).filter(Boolean);
  if (tools.length === 0) {
    throw new Error(`${abs}: 没有解析出任何工具（需要 name + description + input/parameters）`);
  }
  return tools;
}
