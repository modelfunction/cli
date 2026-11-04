import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./fsutil.js";

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const SECRET_PATTERNS = [
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, replacement: "$1***" },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: "***" }
];

const registeredSecrets = new Set();

export function configDir() {
  const override = process.env.MF_CONFIG_DIR;
  return override && override.trim() ? resolve(override.trim()) : join(homedir(), ".modelfunction");
}

export function credentialsPath() {
  return join(configDir(), "credentials.json");
}

export async function readCredentials() {
  let raw;
  try {
    raw = await readFile(credentialsPath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the file content: it holds secrets.
    throw new Error(`credentials file is not valid JSON: ${credentialsPath()}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`credentials file must be a JSON object: ${credentialsPath()}`);
  }
  const out = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  registerSecrets(Object.values(out));
  return out;
}

export async function setCredential(name, value) {
  if (!ENV_NAME.test(name)) {
    throw new Error(`invalid environment variable name "${name}" (expected e.g. DEEPSEEK_API_KEY)`);
  }
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("empty value; nothing written");
  if (/[\r\n]/.test(trimmed)) throw new Error("value must be a single line");
  const existing = await readCredentials();
  existing[name] = trimmed;
  await mkdir(configDir(), { recursive: true, mode: DIR_MODE });
  await writeFileAtomic(credentialsPath(), `${JSON.stringify(existing, null, 2)}\n`, { mode: FILE_MODE });
  registerSecrets([trimmed]);
  return { name, path: credentialsPath() };
}

export async function removeCredential(name) {
  if (!ENV_NAME.test(name)) {
    throw new Error(`invalid environment variable name "${name}" (expected e.g. DEEPSEEK_API_KEY)`);
  }
  const existing = await readCredentials();
  if (!(name in existing)) return { name, removed: false, path: credentialsPath() };
  delete existing[name];
  await mkdir(configDir(), { recursive: true, mode: DIR_MODE });
  await writeFileAtomic(credentialsPath(), `${JSON.stringify(existing, null, 2)}\n`, { mode: FILE_MODE });
  return { name, removed: true, path: credentialsPath() };
}

export async function listCredentials() {
  const stored = await readCredentials();
  return Object.entries(stored)
    .map(([name, value]) => ({ name, masked: maskSecret(value) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Only fill keys the model registry actually reads; a credentials file must
// not be able to inject arbitrary environment variables into the process.
export async function applyModelCredentials(registry) {
  const stored = await readCredentials();
  const names = new Set(
    Object.values(registry)
      .map((config) => config?.apiKeyEnv)
      .filter((name) => typeof name === "string" && name.length > 0)
  );
  const filled = [];
  for (const name of names) {
    if (!process.env[name] && stored[name]) {
      process.env[name] = stored[name];
      filled.push(name);
    }
  }
  return filled;
}

export function maskSecret(value) {
  const text = String(value ?? "");
  if (text.length <= 8) return "********";
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

export function registerSecrets(values) {
  for (const value of values ?? []) {
    if (typeof value === "string" && value.length >= 8) registeredSecrets.add(value);
  }
}

export function redactText(text) {
  let out = String(text ?? "");
  for (const secret of registeredSecrets) out = out.split(secret).join("***");
  for (const { pattern, replacement } of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
