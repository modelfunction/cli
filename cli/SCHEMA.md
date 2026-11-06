# Schemas v1

自 `modelfunction-cli@0.4.3` 起冻结为 v1；`0.4.4` 是同一 v1 的补丁；`0.5.0` 增加 §9 本地文件、`0.5.1` 增加 §10 审计 JSON，仍属 v1。这里描述 CLI 与库对外的稳定契约。人类可读文本（表格、提示语）不属于契约；**JSON 字段**属于。

## 兼容政策

- v1 内只做**加法**：新增字段、新增命令、新增可选参数。消费方必须忽略未知字段。
- 重命名、删除、单位/语义变化 → major 版本；至少提前 **2 个 minor 或 90 天**标记弃用。
- `mf --version` 与包版本是唯一版本锚点；报告里不重复写 schema 版本。
- 未复核用例（`reviewed: false`）永远不计入正式分数，这条不受版本影响。

## 1. suite.json v1

```json
{
  "name": "my-agent",
  "description": "可选",
  "tools": [ ... ],
  "cases": [ ... ],
  "skills": [ ... ],
  "profiles": { "group-a": ["tool_x", "tool_y"] },
  "execution": { "runtime": "node", "entry": "tools/index.mjs" }
}
```

### tools[]

两种写法：

```json
{ "name": "search_docs", "description": "…", "parameters": { "type": "object", "properties": {} } }
{ "ref": "fixtures/tools/search_docs.json" }
```

- `name` 必填、非空、同套件内唯一。
- `parameters` 可用 `input` 代替（function.json 兼容）。缺省为空对象 schema。
- `descriptionSource: "runtime"`：描述由代码运行时生成，静态检查只报 info。
- `sideEffects`: `"none" | "read" | "write" | "external"`，执行准入用。
- `ref` 指向 function.json；读取 `name` / `description` / `input` 或 `parameters`。

### cases[]

```json
{
  "id": "c1",
  "input": "帮我把这份文档转成 PDF",
  "expectedTool": "convert_pdf",
  "expectedArgs": { "path": "a.docx" },
  "toolInput": { "path": "a.docx" },
  "expect": { "ok": true, "contains": "pdf", "maxDurationMs": 2000 },
  "note": "",
  "source": "manual",
  "reviewed": true,
  "excludeFromBase": false,
  "excludeFromProfiles": false,
  "tags": []
}
```

- `input` 必填；`expectedTool: null` 表示负例（不该调用任何工具）。
- `expectedArgs` 仅在有 `expectedTool` 时可用；值为断言，支持字面量、`$contains`、`$oneOf`、`$exists`。
- `toolInput` + `expect` 用于 `--execute`：`expect` 支持 `ok`、`contains`、`equals`、`errorType`、`maxDurationMs`、`maxPeakRssMB`。
- `reviewed` 缺省为 `true`（手写用例）；`mf case add` 缺省写入 `source=agent`、`reviewed=false`。
- `excludeFromBase` / `excludeFromProfiles` 必须是布尔值。用例仍会实际调用（不省 token），只是不计入对应范围的正式指标；用于「该用例只对某一挂载形态有意义」的情况。

### skills[]

字符串或对象：

```json
"pdf-report"
{ "name": "pdf-report", "description": "生成 PDF 报告" }
```

skills 只做静态检查，不参与模型评测。

### profiles

组名 → 工具名数组（`{ "group": ["tool", ...] }`）。也接受平台常见的两种形态：对象 `{ "0": { agentType, tools, skills } }` 与数组 `[{ agentType, tools, skills }]`，组名依次取 `name` → `agentType` → 键/下标；`skills` 字段目前被忽略（profiles 只用于工具挂载与 eval 分组）。所有工具名必须存在；组可重叠，组名不可重复。`mf eval --profile` 与 `mf ablate --profile` 依赖它。

### execution

`runtime`（`node` | `python`）、`entry`、`python`、`export`、`timeoutMs`、`allowRead`、`allowWrite`、`allowNet`。命令行参数优先于文件。

## 2. 评分卡 JSON（`mf eval --json` / `--out report.json`）

```json
{
  "suite": {
    "name": "...", "path": "...",
    "tools": ["..."], "cases": 12,
    "fingerprint": "sha256:...",
    "execution": { "runtime": "node", "engine": "node-permission", "entry": "index.mjs", "hash": "..." }
  },
  "models": [ { "model": "dsv4-flash", "total": 12, "reviewedTotal": 12, "excludedTotal": 0,
               "selectionAccuracy": 0.83, "selectionAccuracyExcludingErrors": 0.83,
               "argAccuracy": 0.9, "passRate": 0.75, "errors": 0, "errorsByKind": {},
               "scoredTotal": 12, "retries": 0, "p50LatencyMs": 900,
               "p95LatencyMs": 1800, "avgCost": 0.001, "totalCost": 0.012,
               "costCurrency": "CNY", "avgCostCny": 0.001, "totalCostCny": 0.012,
               "inputTokens": 1000, "cachedTokens": 0, "outputTokens": 200,
               "totalTokens": 1200,
               "rows": [ { "id": "c1", "expectedTool": "...", "actualTool": "...",
                           "selectionCorrect": true, "args": { "total": 1, "matched": 1, "failures": [] },
                           "passed": true, "reviewed": true, "source": "manual",
                           "latencyMs": 900, "usage": { "input": 80, "output": 20 }, "error": null,
                           "retries": 1 } ] } ],
  "profiles": { "groups": [ ... ] }
}
```

- 正式指标只统计 `reviewed` 且未被 `excludeFromBase` 排除的行；未复核与排除结果单独给出。
- `errors` 是调用层失败（超时、HTTP、网络）的数量，按 `errorsByKind` 分类；它们仍计入 `selectionAccuracy`（保守口径），同时给出排除错误后的 `selectionAccuracyExcludingErrors` 与可评分行数 `scoredTotal`。
- `retries` 是本轮因 429/5xx/网络错误而重试的请求次数（模型级汇总；行级只在大于 0 时出现）。重试不改变判分：最终成功的请求按正常结果计分，最终失败的仍计入 `errors`。
- `inputTokens` / `cachedTokens` / `outputTokens` / `totalTokens` 是客观计量（`totalTokens = inputTokens + outputTokens`，缓存 token 已含在输入内）。成本需要模型注册表的 `pricing`；`currency` 取模型注册表条目（CNY/USD，默认 CNY）。读 `totalCost` / `avgCost` 时一并读 `costCurrency`；`totalCostCny` / `avgCostCny` 只在 CNY 时出现，是兼容别名。
- `--repeat` 时模型对象带 `stability`（翻转用例与多次结果分布）。
- `--profile` 时每个组含 `profile`、`mounted`、`allInOne`、`delta`、`lifted`、`jammed`、`errors`，以及 `usage`（`inputTokens` / `cachedTokens` / `outputTokens` / `totalTokens` / `cost` / `costCurrency`；CNY 时另带 `costCny`）；错误行不参与挂载对比（不会被记成 jammed），每个组的 `reviewed` 是可评分行数。
- `fingerprint` 由工具与用例内容计算；`mf compare` 用它判断两份报告是否可比。

## 3. 扫描输出（`mf scan`）

`--json` 输出 `{ "report": {...}, "draft": {...} }`；默认写 `mf.suite.json`（draft）与 `mf.scan.json`（report）。

report：`root`、`tools[]`（`name` / `description` / `parameters` / `origin` / `confidence` / `source` / `note?` / `descriptionSource?`）、`skills[]`、`mcpServers[]`（env 只保留 `envKeys`，headers 只保留 `headerKeys`；URL 去掉 userinfo / query / hash）、`probes[]`（`server` / `ok` / `toolCount?` / `tools?` / `error?`）、`sources[]`、`warnings[]`。`--probe` 支持 stdio 与 streamable HTTP 两种传输。

`scan --json` 在工具与 skill 都未找到时退出码为 3（只有 skill 也算有结果，退出 0）。

## 4. lint JSON

```json
{
  "tools": 47, "skills": 53,
  "counts": { "error": 0, "warn": 5, "info": 12 },
  "findings": [
    { "severity": "warn", "code": "pair-no-boundary", "kind": "tool",
      "tool": "tavily_search", "pair": ["tavily_search", "google_search"],
      "message": "...", "suggestion": "..." }
  ],
  "profilePairs": [ { "a": "group-a", "b": "group-b", "pairs": [ ... ] } ]
}
```

- `kind: "skill"` 时用 `skill` 字段代替 `tool`。
- `param` 出现在参数级发现上；`pair` 出现在工具对/技能对发现上；`ref` / `similarTo` 出现在悬空工具名引用上。
- `profilePairs` 只在套件含 `profiles` 时出现。
- 0.6.1 新增两条 advisory（均为 `info`，不影响 `check()` 的 pass/warn）：
  - `param-optional-imperative`：可选参数的描述用了祈使句；用户输入没提供该参数时可能抑制调用。
  - `desc-dangling-tool`：描述引用了套件中不存在的工具名；`similarTo` 给出共享领域词的现有工具，通常来自改名后遗留的引用。

## 5. cluster JSON（`mf cluster --json`）

```json
{
  "threshold": 0.5, "total": 47,
  "clusters": [ { "label": "session", "tools": ["..."] } ],
  "riskyPairs": [ { "a": "...", "b": "...", "similarity": 0.85, "basis": "structural" } ],
  "familyHints": [ { "token": "session", "size": 6, "merged": ["..."], "loose": ["..."] } ],
  "boundaries": [
    { "label": "task", "size": 6, "tools": ["..."],
      "axes": [ { "tool": "task_get", "distinct": ["get"], "paramsOnly": [] } ],
      "sharedParams": ["taskId"],
      "pairs": [ { "a": "task_get", "b": "task_output", "similarity": 0.65, "basis": "structural" } ],
      "suggestion": "..." }
  ]
}
```

`boundaries[]` 是族内边界清单的结构化版本；`basis` 为 `lexical` / `structural` / `family`。

## 6. `check()`（安装门禁）

```js
import { check } from "modelfunction-cli";
```

输入 `{ manifest, installed }`：`manifest` 是一个能力（`name` 必填，`description` 可选，`parameters` / `inputSchema` / `input` 任一为 JSON Schema；无 schema 视为 skill）。`installed` 可以是能力数组、`{ tools: [], skills: [] }`，或直接传 `mf scan --json` 的输出（能力在 `report` 下）。空对象视为没有已装能力；其他无法识别的形状会抛错，避免静默返回假的 `pass`。

返回：

```json
{
  "verdict": "pass",
  "summary": { "error": 0, "warn": 0, "info": 1 },
  "findings": [ { "severity": "info", "code": "skill-pair-sibling", "subject": "feishu-wiki",
                  "with": "feishu-doc", "message": "...", "suggestion": "..." } ],
  "family": ["feishu-doc", "feishu-wiki"]
}
```

- `verdict` 只有 `pass` / `warn`，**没有 fail**；质量判定不阻断安装。
- **严重度策略（门禁语境）**：只有会改变模型行为的规则保持原等级——`desc-missing`、`param-type-missing`（error），`required-unsourced`、`pair-no-boundary`、`skill-pair-no-boundary`（warn）；描述、命名、必填数量等质量规则降为 `info`，避免成熟工具集每次安装都告警。`mf lint` 不受影响，仍输出原始严重度。
- 抛错场景：`manifest.name` 缺失或为空；`installed` 不是上述三种形状之一（空对象仍视为无已装能力）。
- 同步、无网络、无文件系统、无状态。类型声明见 `lib/check.d.ts`。
- 性能（0.5.3）：每个能力只分词一次，且只比较涉及新能力的对。真实 100 能力清单（53 新 + 47 已装）约 40–50ms，47 工具对 53 skill 约 25ms；550 个高度同质的合成最坏情况约 2s。

批量（一次安装一包）：

```js
import { checkMany } from "modelfunction-cli";
const result = checkMany({ manifests: [/* ... */], installed: [/* ... */] });
```

返回 `{ verdict, summary, items, results[] }`：

```json
{
  "verdict": "warn",
  "summary": { "error": 0, "warn": 1, "info": 0 },
  "items": 2,
  "results": [
    { "name": "gitcrawl", "verdict": "warn", "summary": { "error": 0, "warn": 1, "info": 0 },
      "findings": [ { "severity": "warn", "code": "skill-pair-no-boundary", "subject": "gitcrawl",
                      "with": "tag-duplicate-prs-issues", "message": "...", "suggestion": "..." } ],
      "family": ["gitcrawl", "tag-duplicate-prs-issues"] },
    { "name": "tag-duplicate-prs-issues", "verdict": "warn", "summary": { "error": 0, "warn": 1, "info": 0 },
      "findings": [ /* 同一对，subject 为自身 */ ], "family": ["gitcrawl", "tag-duplicate-prs-issues"] }
  ]
}
```

`summary` 按 subject/with 去重（同一对只计一次）；`results[]` 保留与该能力相关的全部发现（pair 会出现在双方）。`manifests` 为空、某项缺 name、名称重复时抛错。CLI：`mf check --manifests pack.json [--installed installed.json] [--json]`。

## 7. MCP 工具

| 工具 | 参数 |
| --- | --- |
| `scan_tools` | `root?`、`probe?`、`timeoutMs?`、`writeSuite?` |
| `list_suite` | `suite?` |
| `coverage` | `suite?` |
| `audit` | `suite?` |
| `lint` | `suite?` |
| `check` | `manifest`（对象）、`installed?`（数组或 `{tools,skills}`） |
| `cluster` | `suite?`、`threshold?`、`maxSize?` |
| `compare` | `before`、`after`（评分卡 JSON 路径） |
| `add_cases` | `suite?`、`cases[]`、`source?`、`reviewed?`、`dryRun?` |
| `run_eval` | `suite?`、`models?`、`cases?`、`profile?`、`repeat?`、`failUnder?`、`maxCost?`、`maxTokens?`、`retry?`、`minInterval?`、`progress?` |

返回值均为 JSON 文本。

## 8. 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（`mf check` 的 warn 也是 0） |
| 1 | 输入/用法错误；`mf compare` 判定不可直接比较 |
| 2 | `mf eval --fail-under` 未达标、`--fail-on-regression` 发现回退或无法判定（基线模型缺失、本轮全部调用失败）、`--max-cost` / `--max-tokens` 超限 |
| 3 | `mf exec` 被权限策略拒绝；`mf scan --json` 未找到工具或 skill |
| 4 | `mf exec` 超时 |

## 9. 本地文件（0.5.0 起）

### `~/.modelfunction/credentials.json`

`MF_CONFIG_DIR` 可覆盖目录。扁平 JSON 对象，键为环境变量名、值为字符串：

```json
{ "DEEPSEEK_API_KEY": "sk-…" }
```

权限 0600（Windows 尽力）。加载规则：进程环境变量优先；凭证文件只补模型 registry 中声明的 `apiKeyEnv` 缺失项，不会向进程注入任意变量。不要提交到仓库；CI/企业用环境变量或密钥管理。

### `~/.modelfunction/usage/YYYY-MM.jsonl`

每行一个 JSON 事件（UTF-8，按 UTC 月份分文件；`ts` 为 ISO 8601）：

```json
{
  "schema": 1,
  "ts": "2026-11-01T01:26:33.000Z",
  "command": "eval",
  "exitCode": 0,
  "durationMs": 1200,
  "mf": "0.5.0",
  "platform": "win32",
  "arch": "x64",
  "node": "24.6.0",
  "ci": false,
  "models": ["mock"],
  "caseCount": 13,
  "toolCount": 4,
  "reviewedCount": 13,
  "repeat": 1,
  "profileGroups": 0,
  "selectionAccuracy": 0.92,
  "argAccuracy": 1,
  "passRate": 0.92,
  "unstableCases": 0,
  "failedThreshold": false,
  "regressions": false
}
```

字段为白名单，只含计数、比率与 id；**不含**用例原文、工具描述、源码、文件路径或密钥。`ci` 表示检测到 CI 环境（`CI=true/1` 或 `GITHUB_ACTIONS` / `GITLAB_CI` / `CIRCLECI` / `TRAVIS` / `BUILDKITE` / `TF_BUILD` / `JENKINS_URL` / `CNB_BUILD_ID`），用于把机器运行与本地运行分开；`mf stats` 分别统计。新增字段属于 v1 加法，消费方可忽略未知字段。`MF_NO_USAGE=1` 关闭写入；删除 `usage/` 即清空。

### `mf feedback` 包

默认写到 `MF_CONFIG_DIR/feedback/mf-feedback-YYYYMMDD-HHmmss.json`（UTC）：

```json
{
  "schema": 1,
  "kind": "modelfunction-feedback",
  "generatedAt": "2026-11-01T01:26:33.000Z",
  "mf": { "version": "0.5.0", "node": "24.6.0", "platform": "win32", "arch": "x64" },
  "usage": { "runs": 1, "commands": { "eval": 1 } },
  "privacy": "…",
  "request": "…"
}
```

`usage` 是 `mf stats` 的聚合结果，不含原始事件、路径或密钥。是否发送由用户决定。

## 10. 工具集审计（`mf audit --json`，0.5.1 起）

```json
{
  "suite": { "name": "…", "path": "…", "tools": 4, "skills": 0, "cases": 13, "reviewed": 13 },
  "lint": {
    "tools": 4,
    "skills": 0,
    "counts": { "error": 0, "warn": 6, "info": 0 },
    "findings": [],
    "profilePairs": []
  },
  "clusters": {
    "threshold": 0.5,
    "total": 4,
    "clusters": [],
    "riskyPairs": [],
    "familyHints": [],
    "boundaries": []
  },
  "coverage": {
    "total": 13,
    "negative": 1,
    "negativeRatio": 0.08,
    "unreviewed": 0,
    "tools": [],
    "pairs": [],
    "profiles": [],
    "warnings": []
  },
  "profiles": { "groups": [], "warnings": [], "unmounted": [] },
  "actions": [
    {
      "kind": "boundary|param-source|cases|args|review|mount",
      "subject": "…",
      "message": "…",
      "detail": "…"
    }
  ]
}
```

`profiles` 为 `null` 表示套件未定义分组。`clusters`/`coverage` 的明细与 §5/§4 同源；`actions` 是给人看的优先级列表。`mf audit` 恒退出 0（advisory），不阻断流程；负例占比告警只按整 suite 计算，分组表里的 `negativeRatio` 是该组「正例 + 负例」内的比例，仅供参考。
