# MCP 工具审计：不给源码也能跑

适用于工具在运行时注册、仓库里静态扫描提取不到的项目：把 server 声明放进
`.mcp.json`，让 mf 连上去读 `tools/list`，再对描述与参数 schema 做静态检查。

## 最小用法

```bash
# 仓库根目录放 .mcp.json（同 Claude Code / Cursor 的格式）
npx -y modelfunction-cli@0.15.0 scan --probe --timeout 120000
npx -y modelfunction-cli@0.15.0 lint --suite mf.suite.json --json > mf-lint.json
npx -y modelfunction-cli@0.15.0 audit --suite mf.suite.json --out mf-audit.md
```

`scan --probe` 支持 stdio 与 streamable-HTTP；env 只保留键名、URL 去掉
userinfo/query/hash、headers 只保留键名。Windows 上 0.13.1 起经
`cmd.exe /d /s /c` 启动 `npx`/`npm` 垫片。

**冷启动**：`npx`/`uvx` 型 stdio server 首次启动要先下载依赖，60 秒可能不够
（实测 uvx 冷启动报 `timeout after 60000ms`，热缓存后正常）。模板默认
`--timeout 120000`；本地已预装或 CI 缓存命中时可收紧到 30000–60000。
超时只把该 server 记为失败探测，不影响其他 server，报告里能直接看出是哪台
没起来。

## CI 模板

复制 `templates/ci/mcp-audit.yml` 到 `.github/workflows/`：每周一与手动触发，
零密钥、零模型调用，产物（审计 markdown + lint JSON）作为 artifact 上传。
没有 `.mcp.json` 时显式失败，不静默扫空。

## 边界

- **只读**：只发 `initialize` 与 `tools/list`，不调用任何工具、不执行被审计代码、不调用模型。
- **不是安全边界**：server 进程由你自己配置并启动，权限由它决定；不要指向不可信 server。
- **版本漂移**：`tools/list` 反映 server 当前版本；升级 server 后重跑即可，
  跨版本比较依赖评分卡指纹，不适用于纯审计报告。

## 怎么读报告

- **error**（如 `param-type-missing`）：schema 结构性缺失，优先修；联合类型
  （`anyOf`/`oneOf`/`$ref`）在 0.13.2 起不会被误报。
- **warn `pair-no-boundary`**：工具间相似且没写互斥边界，是真实的选择风险；
  `mf cluster` 会给出按相似度排序的待办与区分轴。
- **`desc-no-when` / 长度类**：风格 advisory。对外部项目不要当 bug 报；
  先攒成建议，再决定是否值得开 issue。

## 实测样例（2026-11-20）

| server | 工具数 | lint error | 说明 |
|---|---|---|---|
| playwright-mcp（官方） | 25 | 0 | 旧版误报 5 条 nullable `anyOf`，0.13.2 修复 |
| memory（官方参考） | 9 | 0 | create/delete relations 相似度 1.00，建议补边界句 |

完整记录见 `docs/2026-11-20-probe-audit.md`。
