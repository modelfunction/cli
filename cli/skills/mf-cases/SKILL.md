---
name: mf-cases
description: 为 ModelFunction 评测套件撰写 function-calling 用例。当用户要求“给这些工具写评测用例 / 补测试用例 / 检查覆盖率 / 测模型会不会选对函数”时使用。
---

# 目标

为已有的工具定义写**可直接运行**的评测用例，覆盖工具选择与参数填充的常见失败模式。

# 输入

0. 还没有套件时：先调 `scan_tools`（`probe=true` 可连 MCP server）并传 `writeSuite: "mf.suite.json"`，得到工具清单草稿，再补用例。
1. 工具定义：`mf.scan.json` 或 `mf.suite.json`（只看名字、description、parameters）
2. 覆盖率现状：`mf coverage --suite <file> --json`
3. 可选：用户提供的真实日志、投诉记录、产品文档

# 规则

1. **只从 schema 取材**：工具名、参数名必须与定义一致，不得发明。
2. **数量**：每个工具至少 3 条；负例（`expectedTool: null`）占全部用例 ≥20%。
3. **必须覆盖的失败模式**：
   - 近义工具混淆（两个工具描述相近，用户话里只有一处细节能区分）
   - 用户没提供必要参数（推荐用负例表达“应追问”，而不是编造参数）
   - 中英混输、口语化表达
   - 多意图（用户一句话里两个诉求，必须确定主意图）
4. **input 要像真实用户**：不要出现工具名，不要写“请调用 xxx”。
5. **期望参数**用以下形式之一：
   - 普通值（数字、枚举、短字符串，比较时去空格）
   - `{ "$contains": "子串" }`（长文本字段）
   - `{ "$oneOf": [..] }`（可接受多个等价取值）
   - `{ "$exists": true|false }`（只关心有没有）
6. **不要用被测模型生成用例**，也不要让被测模型参与出题。

# 描述边界写法（实测）

- 排除具体竞争者时**点名**：`do NOT call file_read` 有效；泛化否定（`no separate file reads`）几乎压不住任何工具。
- 可选参数不要用祈使句（“传一个 title”）；用户没给该参数时，模型可能干脆不调用。改成条件式：“如有 title 可传入”。
- 改名工具后，检查所有 description 是否还引用旧名；悬空引用会继续误导模型。
- 用例话术必须提交范围（公网 / 本地 / 会话历史）；“上周那个记录”这类歧义无法靠描述修复，只能改话术。

# 输出格式

```json
[
  {
    "id": "agent_001",
    "input": "用户原话",
    "expectedTool": "工具名或 null",
    "expectedArgs": { "参数名": "值或匹配器" },
    "note": "为什么这条用例重要（可选）",
    "source": "agent",
    "reviewed": false,
    "tags": ["confusion", "negative"]
  }
]
```

# 写入与自检

```bash
mf case add --suite <file> --input cases.json     # 默认 source=agent、reviewed=false
mf coverage --suite <file>                        # 看是否达标
mf eval --models mock --show-cases                # 先离线跑一遍，确认用例本身可执行
```

写入后提醒用户：**未复核用例不计入正式分数**，需要在 `mf eval` 前把 `reviewed` 改为 `true`，或用 `--reviewed` 添加。
