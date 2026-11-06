# modelfunction-cli

`mf` — 测你的模型会不会选对 function、参数填得对不对，输出多模型评分卡。本地运行，不开机自启、不驻留、不上传代码。

## 安装

```bash
npx -y modelfunction-cli@0.6.1 --version
# 或
npm i -D modelfunction-cli
npx mf --version
```

全局安装（可选）后命令为 `mf`，也可以用 `modelfunction`——避开装了 TeX 的机器上 `mf` 与 Metafont 同名：

```bash
npm i -g modelfunction-cli
modelfunction --version
```

## 五步上手

```bash
mf scan --root .                      # 找 function.json / OpenAPI / MCP 配置 / SKILL.md
mf scan --root . --probe              # 连 stdio MCP server 拉 tools/list
mf coverage --suite mf.suite.json     # 看每个工具还缺多少用例
mf eval --suite mf.suite.json --models deepseek,qwen --show-cases
mf compare before.json after.json     # 跨版本比较（内容指纹判定可比性）
mf audit --suite mf.suite.json --out audit.md  # 一次静态体检：lint + 边界 + 覆盖 + 挂载
```

被测模型用环境变量提供 Key：

```bash
DEEPSEEK_API_KEY=... mf eval --models deepseek
DASHSCOPE_API_KEY=... mf eval --models qwen
ZHIPU_API_KEY=... mf eval --models glm
SILICONFLOW_API_KEY=... mf eval --models dsv4-flash
OPENAI_API_KEY=... mf eval --models openai
```

也可以把 Key 存进用户级凭证文件，输入时隐藏、不进 shell history：

```bash
mf config set-key DEEPSEEK_API_KEY   # 粘贴 Key，回车；只显示掩码
mf config list                       # DEEPSEEK_API_KEY  sk-…abcd
mf config path                       # ~/.modelfunction/credentials.json（0600）
```

加载优先级：**进程环境变量 > 凭证文件**（只补缺失项，不覆盖）。CI 与企业环境继续用环境变量或密钥管理，不要落盘。

### 自建 / 内网网关

企业内网基本都是 OpenAI 兼容协议，写一个 models-file 即可（Key 用环境变量，或用 `mf config set-key` 存在本机）：

```json
{
  "internal-ds": {
    "type": "openai",
    "baseUrl": "https://llm.example.internal/v1",
    "model": "deepseek-v4-flash",
    "apiKeyEnv": "INTERNAL_LLM_KEY"
  }
}
```

```bash
INTERNAL_LLM_KEY=... mf eval --suite mf.suite.json \
  --models-file my-models.json --models internal-ds
```

`pricing` 可省（省了就不输出成本）；要算成本请按自家价目填写，默认 registry 里的价格只是参考值。价格条目旁写 `"currency": "USD"`（默认 `CNY`）即可切换币种；token 用量不受此影响，始终是客观计量。

## 命令

| 命令 | 作用 |
| --- | --- |
| `mf scan` | 扫描工具定义（function.json / OpenAPI / MCP 配置 / Python `@tool` / JS·TS 声明与 TypeBox·zod schema）；`--probe` 连 stdio 或 streamable-HTTP MCP server（运行时结果覆盖静态推断；headers/query 不写入报告）；`--from` 导入运行时工具数组；草稿按来源分组（`profiles`）并列出未覆盖的 skill |
| `mf eval` | 跑评分卡；`--repeat` 多次取多数并报不稳定用例；`--fail-under` 阈值；`--baseline` + `--fail-on-regression` 回归门禁；`--profile` 按挂载组分别评分；`--max-cost` 按累计成本停机（退出 2，币种随 registry）；`--max-tokens` 按累计 input+output token 停机（退出 2）；`--retry` 429/5xx 重试次数；`--min-interval` 请求最小间隔（压 RPM）；`--progress` 逐用例进度（stderr） |
| `mf case add` | 写入用例（默认 `source=agent`、`reviewed=false`） |
| `mf coverage` | 每工具用例数、参数覆盖、负例比例、疑似混淆对；有 `profiles` 时按组统计 |
| `mf audit` | 一次静态审计：lint + 混淆族边界 + 用例覆盖 + 挂载检查，输出可转发的 Markdown/JSON；不调用模型 |
| `mf lint` | 静态检查工具描述与参数 schema，以及 skills 的 name/description（不调用模型）；0.6.1 起含「可选参数祈使句」与「悬空工具名引用」两条 info 规则；重复规则自动合并成一条；有 `profiles` 时给出「这些组不要合并挂载」 |
| `mf check` | 安装门禁：一个或一包新能力 × 已装能力（`--manifest` / `--manifests` + `--installed`），纯静态、返回 pass/warn、不阻断；门禁语境只对混淆对/必填来源/结构性错误报 warn，其余降 info；也可 `import { check, checkMany } from "modelfunction-cli"` |
| `mf compare` | 跨版本比较、干扰归因、混淆矩阵；两份报告都有分组时按组对比 |
| `mf ablate` | 留一法：去掉某个工具再跑一遍，量化它是否干扰其他工具；`--profile` 限定在某个挂载组内 |
| `mf cluster` | 聚类工具，建议挂载分组；参数形状拆散的同一族（如 `sessions_*`）列为「同族候选」；并输出「族内边界清单」（每族会互抢的对 + 每个工具可用的区分词）；`--out` 把分组写成套件的 `profiles` |
| `mf exec` | 单工具执行 + 指标（Node / Python），支持 `--allow-read/write/net`、超时、sideEffects 准入 |
| `mf eval --execute` | 一次跑完选择 + 参数 + 运行断言（`toolInput` / `expect`） |
| `mf sandbox check` | 探测本机可用隔离引擎与降级建议 |
| `mf config set-key` | 把模型 Key 写入 `~/.modelfunction/credentials.json`（隐藏输入）；`remove-key` 删除；`list` 只显示掩码，`path` 打印路径 |
| `mf stats` | 本地使用摘要（命令次数、本地/CI 区分、模型、通过率区间、lint 规则命中）；不联网 |
| `mf feedback` | 导出脱敏反馈包（仅计数与比率），发不发由你决定 |
| `mf mcp` | stdio MCP server，供 Claude Code / Cursor / Kimi Code 调用 |

## 单次结果会抖：用 `--repeat` 看稳定性

实测 DeepSeek-V4-Flash：同一条用例、temperature=0，一次选对、下一次干脆不调用。单次评分卡里 ±1 条用例就是 ±8pp，小套件上足以把"分组有没有用"看反。

```bash
mf eval --models dsv4-flash --repeat 3    # 每条跑 3 次取多数，并列出结果不稳定的用例
```

`--repeat` 会让调用次数和成本乘以 n；正式基线建议 3 次，日常回归 1 次够用。

## 挂载分组：验证"少挂一点"值不值

平台通常按业务把工具拆给不同 agent（网优 / 故障 / 运维各挂各的）。分组到底降了多少误选，用同一批用例比一次就知道：

```bash
mf cluster --suite mf.suite.json --out mf.suite.json    # 写入建议分组（profiles），可手工修改
mf eval --suite mf.suite.json --models internal-ds \
  --profile all --out report.md                        # 每组 vs 全量，一页 markdown
```

每组只跑"本组工具 + 本组用例"，负例（不该调用工具）每组都跑；`all-in-one` 列是同一批用例在全部工具都挂时的结果。两列之差就是分组收益，按组给出，可直接拿去和平台方对账。工具很少时分组通常没有收益（模型本来就选得对），差异小于 10pp 请先加 `--repeat 3` 复核再下结论。

配套的三个检查：`mf lint` 列出组间高风险对（相似工具分属不同组，合并挂载会互抢）；`mf coverage` 按组看谁还缺用例；两次 `--profile` 报告之间用 `mf compare` 看各组升降（分组定义变了会明确标注不可比）。组内还有干扰时，用 `mf ablate --profile <组> --tool <工具>` 做组内留一法，看拆掉谁最划算。

`mf cluster` 还会输出**族内边界清单**：把会互抢的工具对按连通关系分成「族」，每族列出各工具名称里的独有词（名称没有独有词时退到独有参数）作为区分轴，并标出共享参数（不能当判据）。这是写给作者的动作项——每个工具补一句"何时用我、何时用对方"即可，不需要先跑模型。`--json` 的 `boundaries[]` 是该清单的结构化版本（`axes` / `sharedParams` / `pairs` / `suggestion`），平台方可以直接消费。

## MCP 配置

```json
{
  "mcpServers": {
    "modelfunction": {
      "command": "npx",
      "args": ["-y", "modelfunction-cli@0.6.1", "mcp"]
    }
  }
}
```

暴露：`scan_tools`、`list_suite`、`coverage`、`audit`、`lint`、`check`、`cluster`、`compare`、`add_cases`、`run_eval`（`run_eval` 支持 `profile`、`repeat`、`maxCost`、`maxTokens`、`retry`、`minInterval`、`progress`）。`lint`/`check`/`cluster`/`compare` 都是静态操作，不调用模型；`check` 就是安装门禁，Agent 可直接传入 manifest 与 installed。

## 契约与版本

对外 JSON 字段、`check()` 返回结构、MCP 参数与退出码见 [SCHEMA.md](SCHEMA.md)，自 0.4.3 起冻结为 v1：v1 内只做加法，重命名或删除字段需 major 并提前两个 minor 或 90 天弃用。`check()` 的类型声明随包发布。

`0.6.1` 已发布到 npm（latest）：新增 `param-optional-imperative` 与 `desc-dangling-tool` 两条 info lint，并把「具名否定 / 泛化否定 / 可选参数祈使句 / 改名引用 / 话术范围」写进 `skills/mf-cases/SKILL.md`。`0.6.0` 已发布到 npm（latest）：token 成为主口径（评分卡新增 `totalTokens`），模型注册表支持 `currency`（CNY/USD，默认 CNY），成本字段改为 `totalCost` / `avgCost` + `costCurrency`（`totalCostCny` / `avgCostCny` 仅在 CNY 时保留），新增 `mf eval --max-tokens <n>` 与 MCP `maxTokens`；`--fail-on-regression` 在基线模型缺失或本轮全部调用失败时改为 exit 2（无法判定 ≠ 无回归），自动选模型时在 stderr 打 note；本地门禁模板改用退出码判定、只在成功 eval 后更新 state，`.cmd` 固定 CRLF。`0.5.5` 含 eval `--retry <n>` / `--min-interval <ms>`、评分卡 `retries`、CI 模板 static 层 `cluster --json`、`templates/local/` 与 `docs/local-gate.md`（内网/非 GitHub 环境的 pre-push 静态门禁、变更门、定时回归）。`0.5.4` 含用例级 `excludeFromBase` / `excludeFromProfiles`、评分卡 `errorKind` / `errorsByKind` / `scoredTotal` / `selectionAccuracyExcludingErrors`、挂载对比错误不计 jammed、audit 分组 `neg%` 与分组 token 用量聚合。`0.5.3` 及更早的能力见下：凭证与本地反馈、usage `ci` 标记、eval `--progress`/`--max-cost`、`mf audit`、`scan --probe` streamable HTTP、MCP 静态工具 `lint`/`check`/`cluster`/`compare`、`checkMany` 一包批量检查、门禁严重度收敛、静态规则性能（真实 100 能力清单 `checkMany` 471ms→40ms）、`installed` 形状校验与 `profiles` 平台形态兼容。示例统一使用 `@0.6.0`。

## 数据边界

- 本地运行，无遥测、无服务端地址
- 唯一出站：你配置的模型端点，以及你自己的 MCP server（`--probe` 时）
- 评测会把用例输入与工具描述发给被测模型供应商——敏感数据请选境内供应商或本地模型

## 本地使用记录与反馈（默认不上传）

每条命令会在 `~/.modelfunction/usage/YYYY-MM.jsonl` 追加一行**计数记录**：命令名、退出码、耗时、mf/Node/OS 版本、模型 id、用例/工具数量、通过率区间、lint 规则命中数、是否 CI。**不记录**用例原文、工具描述、源码、文件路径或密钥。`mf stats` 会把本地运行与 CI 运行分开统计。

```bash
mf stats                    # 看本机记录；--json 给脚本
mf feedback --out out.json  # 导出脱敏反馈包（聚合值，不含原始事件）
```

- 默认无网络、无遥测；`MF_NO_USAGE=1` 关闭记录；直接删除 `~/.modelfunction/usage/` 即清空。
- 反馈包发不发由你决定；我们想知道的是「哪些命令在用、评测通过率大概什么水平、lint 命中哪些规则」，不需要项目细节。
- `MF_CONFIG_DIR` 可改整个配置目录位置（CI/容器里常用）。

## 用例从哪来

由你或你的编码 Agent 撰写，规则模板见包内 `skills/mf-cases/SKILL.md`。未复核用例（`reviewed:false`）不计入正式分数。

工具一多就别手工誊抄，直接让编码 Agent 驱动 `mf`：

```bash
# 1. 把 mf 挂成 MCP server
claude mcp add modelfunction -- npx -y modelfunction-cli@0.6.1 mcp
```

```text
# 2. 让 Agent 扫仓库并写出套件草稿
用 modelfunction 的 scan_tools 扫 .，probe=true，writeSuite=mf.suite.json

# 3. 让 Agent 补用例
按 skills/mf-cases/SKILL.md 的规则，为每个工具补 3 条正例和 1 条负例，用 add_cases
写入 mf.suite.json，然后跑 coverage 看还缺哪些参数和负例
```

```bash
# 4. 人工复核：把认可的用例 reviewed 改为 true，再跑正式评分
mf coverage --suite mf.suite.json
mf eval --suite mf.suite.json --models internal-ds
```

License: MIT
