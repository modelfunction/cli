# 一页集成指南（给开源维护者）

`mf` 检查 Agent 的工具层，不碰提示词和业务代码：扫描工具/skill 定义，静态检查描述、参数和边界，需要证据时再跑真实模型评分卡。

## 三种接入方式

### 1. GitHub Actions：零密钥静态门禁

复制 `templates/ci/github-actions.yml`，或只加一步：

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npx -y modelfunction-cli@0.6.1 lint --suite mf.suite.json
- run: npx -y modelfunction-cli@0.6.1 audit --suite mf.suite.json --out mf-audit.md
```

静态层不调用模型、不需要 secrets，fork PR 也能跑。先保持 advisory，等误报清零后再考虑拦截。

### 2. 本地门禁：不改 CI

`templates/local/pre-push` + `change-detect.mjs` + `nightly.sh|cmd`：push 前跑 `lint`，清单变更才跑回归，回归失败不更新 state。见 `docs/local-gate.md`。

### 3. 库内安装门禁：`check()`

```js
import { check } from "modelfunction-cli";

const result = check({ manifest: newTool, installed: existingTools });
// { verdict: "pass" | "warn", summary, findings, family }
```

纯静态、毫秒级、不阻断；适合在插件/skill 安装时提示混淆对和必填参数来源问题。见 `cli/SCHEMA.md` §6。

## 数据边界

- 本地运行，无遥测、无上传、无服务端；唯一出站是你配置的模型端点。
- 静态命令不执行被扫描代码；`mf exec` / `eval --execute` 必须显式开启，且是能力限制不是安全边界。
- 密钥只走环境变量或 `mf config set-key`；`scan --probe` 会脱敏 env/URL/header。
- 本地 usage 计数只存命令名与计数，可用 `MF_NO_USAGE=1` 关闭。

## 性能

- `checkMany` 真实 100 能力清单约 40ms；550 个合成能力最坏约 2.1s。
- 静态 `scan`/`lint`/`audit` 不花钱；`eval` 才调用模型。

## 误报

先把结果当 advisory：把 `mf-audit.md` 或评分卡发给我们，标注你认为误报的条目。规则改动会进 golden 语料，不针对单个仓库硬编码。

## 更多

- `AGENTS.md`：给编码 Agent 的可执行入口
- `README.md`：安装与快速开始
- `cli/SCHEMA.md`：评分卡、lint、`check()`、MCP 契约
- `docs/local-gate.md`：内网/非 GitHub 环境
