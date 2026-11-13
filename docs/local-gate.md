# 本地门禁：没有 GitHub Actions 时的静态检查与回归

适用场景：代码在内网、托管在非 GitHub 平台，或官方 CI 接入需要较长审批。
`templates/ci/github-actions.yml` 里的两层（static / eval）都可以在本地还原，
命令一一对应；将来接上 CI 时，把同样的命令搬进 YAML 即可。

模板在 `templates/local/`：

| 文件 | 作用 |
|---|---|
| `pre-push` | push 前静态门禁：`lint` 拦截，`audit` / `cluster` 只写报告 |
| `change-detect.mjs` | 变更门：suite 或模型注册表没变就跳过 eval（0 次调用） |
| `nightly.sh` | POSIX：过变更门后跑回归，写带时间戳的评分卡 |
| `nightly.cmd` | Windows 计划任务入口，逻辑同上 |

## 0. 前置

- Node.js ≥ 20，`npx` 可用。
- mf ≥ 0.5.5（`--retry` / `--min-interval` 从 0.5.5 起提供）。
- 套件：`mf.suite.json`（或 `MF_SUITE` 指定）。
- 模型注册表：`mf.models.json`，只写模型 id → `apiKeyEnv`，不写密钥。
  可从随包发布的 `cli/fixtures/models.json` 复制一份作为起点（用 `npm root -g`
  找到 `modelfunction-cli/fixtures/models.json`）。
- 密钥只走环境变量，永不落盘、不进仓库。

## 1. push 前静态门禁（零密钥、零模型调用）

```bash
cp templates/local/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

行为：

- `mf lint` 失败 → 退出 1，push 被拦截；
- `mf audit` / `mf cluster` 是 advisory，报告写到 `.mf/static/`，不拦截。

Windows（git-bash）下同一份脚本可用；若只用 CMD，可在提交前手动执行同样的命令。

## 2. 变更门：按变更跑，不按日历跑

回归是唯一花钱的环节。`change-detect.mjs` 对 suite 与模型注册表做内容哈希：

```bash
node templates/local/change-detect.mjs              # 输出 run 或 skip
node templates/local/change-detect.mjs --exit-code  # 退出码 1=run、0=skip
node templates/local/change-detect.mjs --mark       # 记录当前哈希
FORCE_EVAL=1 node templates/local/change-detect.mjs
```

- 状态文件：`.mf/eval-state.json`（`{suite, models, updatedAt}`，哈希为 16 位十六进制）；
- 建议把 `.mf/eval-state.json` 与基线一起提交，换机器后不会无故多跑一轮；
- `nightly.*` 用 `--exit-code` 判定，不解析 stdout 文本；`--mark` 只在 eval **退出 0 且评分卡存在**时调用——回归失败（exit 2）或崩溃都不会更新 state，次日会重跑；
- Windows 批处理必须是 CRLF；仓库用 `.gitattributes` 固定 `*.cmd text eol=crlf`。如果你自己生成 `.cmd`，不要写 LF-only，也不要在 `( )` 块里用 `::` 注释或裸 `)` 的 echo。

## 3. 定时回归

```bash
MF_MODELS=mf.models.json MODEL_API_KEY=... templates/local/nightly.sh
```

Windows：

```cmd
set MODEL_API_KEY=...
templates\local\nightly.cmd
```

默认参数（均可用环境变量覆盖）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MF_VERSION` | `0.9.1` | 固定版本，避免 npx 漂移 |
| `MF_SUITE` | `mf.suite.json` | 套件 |
| `MF_MODELS` | `mf.models.json` | 模型注册表 |
| `MF_BASELINE` | `.mf/baseline.json` | 存在时自动加 `--baseline --fail-on-regression` |
| `MF_PROFILE` | 空 | 设为 `all` 时按挂载组评分 |
| `MF_REPEAT` | `3` | 多数票计分 |
| `MF_MAX_COST` | `1` | 成本上限（币种随模型注册表），触顶退出 2 |
| `MF_RETRY` | `4` | 429 / 5xx / 网络错误的重试次数 |
| `MF_MIN_INTERVAL` | `1200` | 请求最小间隔（ms），约 50 RPM |
| `MF_NIGHTLY_DIR` | `.mf/nightly` | 评分卡输出目录 |

产物：

- `.mf/nightly/scorecard.<yyyyMMdd-HHmmss>.json`：本轮评分卡；
- `.mf/eval-state.json`：本轮清单快照；
- 退出码：`0` 通过（含跳过）、`2` 回归 / 基线模型缺失 / 本轮全部调用失败 / 触顶成本 / `--fail-under` 未达标。

注册 Windows 计划任务（每天醒来，但没变更就 0 成本）：

```cmd
schtasks /Create /TN "mf-nightly" ^
  /TR "cmd /c cd /d C:\path\to\repo && templates\local\nightly.cmd >> .mf\nightly\run.log 2>&1" ^
  /SC DAILY /ST 02:17
```

密钥放在任务环境或一个不进仓库的 wrapper 脚本里。

## 4. 端点限流

RPM 受限的端点常见两类噪声：

1. **重试**：`--retry <n>` 对 429、5xx 和网络错误做指数退避，默认 2（共 3 次尝试）；
   服务端返回 `Retry-After` 时优先采用，最长等待 30 秒。
2. **限速**：`--min-interval <ms>` 保证两次请求之间至少间隔 N 毫秒。
   例如端点 60 RPM，用 `--min-interval 1100`；120 RPM 用 `550`。

重试不会把限流算成模型能力问题：最终仍失败的请求进 `errorsByKind.rate-limit`，
并用 `selectionAccuracyExcludingErrors` 单独看模型本身的表现；
评分卡新增的 `retries` 汇总可以看到本轮实际发生了多少次重试。

## 5. 与 Action 模板的对应

| `templates/ci/github-actions.yml` | 本地 |
|---|---|
| static job：`lint` | `pre-push` 第 1 段（拦截） |
| static job：`audit` | `pre-push` 第 2 段（advisory） |
| static job：`cluster --json` | `pre-push` 第 3 段（advisory） |
| eval job 触发条件 | 变更门（本地更严格：清单不变就不跑） |
| eval job：`--repeat 3 --max-cost` | `nightly.*` |
| eval job：条件 `--baseline --fail-on-regression` | `nightly.*` 的 `[ -f baseline ]` |
| eval job：scorecard summary | `.mf/nightly/scorecard.*.json` + `mf compare` |

## 6. 注意

- 门禁是 advisory 还是 blocking 由你决定；`lint` 默认拦截，其余不拦截。
- 基线要随 PR 更新，不要由定时任务自动改写，否则一次抖动会悄悄降低门槛。
- 定义变更（工具/用例）会让 fingerprint 改变，`mf compare` 会跳过回归判断，不会误报。
- 「无法判定」不等于「无回归」：基线模型不在新报告中、或本轮全部已复核调用都失败时，`--fail-on-regression` 退出 2，而不是跳过。
