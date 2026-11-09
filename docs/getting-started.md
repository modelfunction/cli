# ModelFunction 上手（5 步，约 10 分钟）

> 目标：在你的仓库里跑出第一份 function-calling 评分卡，并接进 CI。
> 全部本地运行：不上传代码、不驻留、不开机自启。唯一出站请求是你配置的模型端点。

## 0. 前置

- Node.js ≥ 20
- 一个 OpenAI 兼容的模型端点与 Key（DeepSeek / Qwen / GLM / SiliconFlow / OpenAI，或本地 Ollama）

```bash
npx -y modelfunction-cli@0.7.0 --version
```

可选：装成本地依赖，启动更快

```bash
npm i -D modelfunction-cli
npx mf --version
```

Key 有两种给法：环境变量（CI/企业推荐），或写入用户级凭证文件（隐藏输入，不进 shell history）：

```bash
npx mf config set-key DEEPSEEK_API_KEY
npx mf config list        # 只显示掩码
```

`~/.modelfunction/credentials.json` 权限 0600；进程环境变量优先，凭证文件只补缺失项。

## 1. 找到工具定义

```bash
npx mf scan --root .
```

会识别：`function.json` / `tools.json`、OpenAPI、MCP 配置（`.mcp.json`、`.cursor/mcp.json`、`.vscode/mcp.json`、`claude_desktop_config.json`）、`SKILL.md`、代码内定义（`registerTool()`、`tools: [...]`、`@tool`、`tool({})`）。

想先看整体体检（不调用模型）：

```bash
npx mf audit --suite mf.suite.json --out audit.md
```

报告含 lint 发现、混淆族边界、用例覆盖缺口、未挂载工具，以及按优先级排序的建议动作，可直接转发。

如果工具在 MCP server 里：

```bash
npx mf scan --root . --probe     # 启动 stdio server 并读取 tools/list
```

如果工具是 Zod/Pydantic 运行时构造的，直接导出：

```js
// mf.tools.mjs
export default [
  { type: "function", function: { name: "score_resume", description: "...", parameters: {} } }
];
```

```bash
npx mf scan --root . --from ./mf.tools.mjs
```

产物：`mf.suite.json`（工具 + 空用例）与 `mf.scan.json`（来源与置信度）。

## 2. 写用例（交给你或你的编码 Agent）

**不要用被测模型出题。** 在 Claude Code / Cursor / Kimi Code 里说：

> 读 `mf.scan.json` 的工具定义，按 `skills/mf-cases/SKILL.md` 写 15 条用例，覆盖近义混淆、无工具、缺参数、中英混输，然后 `mf case add` 写入。
>
> （npm 包内路径为 `skills/mf-cases/SKILL.md`；本仓库为 `cli/skills/mf-cases/SKILL.md`。）

```bash
npx mf case add --suite mf.suite.json --input cases.json
npx mf coverage --suite mf.suite.json
```

覆盖率目标：每个工具 ≥3 条、负例 ≥20%、近似工具对至少 1 条歧义用例。
**未复核用例（`reviewed:false`）不计入正式分数**，确认后改 `reviewed:true` 或加 `--reviewed`。

## 3. 跑第一份评分卡

```bash
DEEPSEEK_API_KEY=... npx mf eval --suite mf.suite.json --models deepseek --show-cases
```

输出：选择准确率、参数匹配率、通过率、延迟、成本，以及每条失败用例。
先离线自查用例本身：

```bash
npx mf eval --models mock --show-cases
```

要同时验证“工具真的跑起来对不对”，给用例加 `toolInput` 与 `expect`，然后：

```bash
npx mf eval --models deepseek --execute --entry ./tools/index.mjs
```

入口导出 `run({ tool, arguments })`，返回结果；`expect` 支持 `ok` / `contains` / `equals` / `errorType` / `maxDurationMs` / `maxPeakRssMB`。执行通过率、执行耗时与内存峰值会单独一行输出。

工具定义里要声明 `sideEffects: none | read | write | external`；`write` / `external` / 未声明默认被拦截，需要加 `--allow-side-effects`。

先看看这台机器能用到哪种隔离：

```bash
npx mf sandbox check
```

## 4. 改进与比较

```bash
npx mf lint --suite mf.suite.json                 # 描述/参数问题
npx mf eval --models deepseek --repeat 3          # 结果会抖：正式基线跑 3 次取多数
npx mf eval --models deepseek --out before.json
# 改工具描述后
npx mf eval --models deepseek --out after.json
npx mf compare before.json after.json             # 定义变了会标记“不可直接比较”
npx mf ablate --tool salary_band --models deepseek # 新工具是否抢了别的工具的调用
```

## 5. 按挂载组评测（平台方）

一个平台常有几十个工具，按业务拆给不同 agent 挂载（网优 / 故障 / 运维…）。先用静态聚类拿分组建议，再验证分组到底降了多少误选：

```bash
npx mf cluster --suite mf.suite.json --out mf.suite.json   # 写入 profiles，可手工改
npx mf coverage --suite mf.suite.json                      # 每组还缺哪些用例
npx mf eval --suite mf.suite.json --models deepseek \
  --profile all --out report.md                            # 每组 vs 全量，一页 markdown
npx mf ablate --suite mf.suite.json --profile screening \
  --tool interview_question --models deepseek              # 组内还有干扰？看拆掉谁划算
```

- 每组只跑本组工具 + 本组用例，负例每组都跑；`all-in-one` 列是同一批用例在全部工具都挂时的结果。
- `mf lint` 会列出「两个组不要合并挂载」的高风险对；`mf compare` 在两份报告分组定义一致时按组对比升降。

## 6. 接进 CI

复制 `templates/ci/github-actions.yml` 到你的仓库，改 `--models` 与阈值，并把 Key 放进 Secrets。

- **静态层**：`mf lint` + `mf audit` + `mf cluster --json`，零密钥零成本，所有 PR（含 fork PR）都跑；
- **eval 层**：只在同仓分支/push 跑（fork PR 拿不到 secrets），默认带 `--max-cost`；
- 门槛：`--fail-under 0.85`；建议先保持 advisory（`continue-on-error: true`），等你有一份 `--repeat 3` 的稳定基线后再切硬门禁；
- 回归：`--baseline .mf/baseline.json --fail-on-regression`（任一已复核用例 pass→fail 即失败）；
- 限流端点：`--retry 4 --min-interval 1100`（约 55 RPM），重试只针对 429/5xx/网络错误，不改变判分口径。内网/非 GitHub 环境的本地门禁见 `docs/local-gate.md`。

## 接进编码 Agent（MCP）

```json
{
  "mcpServers": {
    "modelfunction": {
      "command": "npx",
      "args": ["-y", "modelfunction-cli@0.7.0", "mcp"]
    }
  }
}
```

Claude Code 放 `.mcp.json`，Cursor 放 `.cursor/mcp.json`，Kimi Code 按其文档。
可用工具：`scan_tools`、`list_suite`、`coverage`、`add_cases`、`run_eval`（支持 `profile`、`retry`、`minInterval` 参数）。

## 数据边界

- 本地运行；无遥测、无服务端地址
- 唯一出站：你配置的模型端点；`scan --probe` 时还有你自己的 MCP server
- 评测会把用例输入与工具描述发给被测模型供应商——敏感数据请选境内供应商或本地模型
- 本地计数日志在 `~/.modelfunction/usage/`（只含命令、计数、比率；不含用例/路径/密钥），默认不发送；`mf stats` 查看，`mf feedback` 导出脱敏包，`MF_NO_USAGE=1` 关闭

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `model "xxx": environment variable ... is not set` | Key 没设 | 按提示设置环境变量，或先 `--models mock` |
| 不传 `--models` 直接跑 | 无 Key 时自动回退 mock，并提示 | 正常，用于离线自查 |
| `cases 为空` | `scan` 只产出工具 | 用 `mf case add` 补用例 |
| `不可直接比较` | 工具或用例指纹变了 | 确认是有意变更；否则回退定义 |
| 结果波动 | 供应商侧模型漂移 | 重复跑、固定模型版本、看多条用例趋势 |
