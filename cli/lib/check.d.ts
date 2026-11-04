export type Severity = "error" | "warn" | "info";
export type Verdict = "pass" | "warn";

export interface Capability {
  name: string;
  description?: string;
  /** JSON Schema. A capability without one is treated as a prompt-injected skill. */
  parameters?: Record<string, unknown>;
  /** Accepted alias for parameters, matching MCP tool shape. */
  inputSchema?: Record<string, unknown>;
  /** Accepted alias for parameters, matching function.json shape. */
  input?: Record<string, unknown>;
}

export interface InstalledCapabilities {
  tools?: Capability[];
  skills?: Capability[];
}

/** `mf scan --json` output; its capabilities live under `report`. */
export interface ScanReport {
  report: InstalledCapabilities;
}

export interface CheckInput {
  manifest: Capability;
  installed?: Capability[] | InstalledCapabilities | ScanReport;
}

export interface CheckFinding {
  /**
   * Install-gate view: only behavior-changing findings keep warn/error
   * (selection conflicts, unsourced required params, schema errors).
   * Description and naming rules are reported as info so mature tools pass.
   */
  severity: Severity;
  code: string;
  subject: string;
  param?: string;
  /** The installed capability this pair finding is about. */
  with?: string;
  message: string;
  suggestion?: string;
}

export interface CheckResult {
  verdict: Verdict;
  summary: { error: number; warn: number; info: number };
  findings: CheckFinding[];
  /** Connected family of competing installed capabilities, sorted. */
  family?: string[];
}

export interface CheckManyInput {
  manifests: Capability[];
  installed?: Capability[] | InstalledCapabilities | ScanReport;
}

export interface CheckItemResult extends CheckResult {
  name: string;
}

export interface CheckManyResult {
  verdict: Verdict;
  /** Deduplicated by subject/with; per-item summaries are in results[]. */
  summary: { error: number; warn: number; info: number };
  items: number;
  results: CheckItemResult[];
}

/**
 * Static install gate: judge one new capability against installed ones.
 * No model call, no network, no file system, no state.
 * @throws when `manifest.name` is missing or empty, or `installed` is neither
 * an array, `{ tools, skills }`, nor an `mf scan --json` report.
 */
export declare function check(input: CheckInput): CheckResult;

/**
 * Batch install gate: judge a pack of new capabilities against installed ones
 * and against each other.
 * @throws when manifests is empty, an item lacks a name, names are duplicated,
 * or `installed` is not an accepted shape.
 */
export declare function checkMany(input: CheckManyInput): CheckManyResult;

export declare function formatCheck(result: CheckResult): string;

export declare function formatCheckMany(result: CheckManyResult): string;
