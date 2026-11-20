# 双判一致性（标注可靠性）

用例的 `expectedTool` 是耐久资产，但单人标注没有可靠性证据。两个人独立标注同一批
用例，`mf agree` 给出一致率、Cohen's kappa 与需要仲裁的分歧清单——不调用模型、
不联网。

## 标注文件格式

```json
{ "annotator": "alice", "labels": { "r01": "resume_score", "n01": null } }
```

- `null` 表示「这条不该调用工具」；
- 也可以直接给映射 `{ "r01": "resume_score" }`，或数组
  `[{ "id": "r01", "expectedTool": "resume_score" }]`；
- 两份文件各自独立完成，仲裁前不要互相看。

## 用法

```bash
mf agree --a alice.json --b bob.json --suite mf.suite.json
mf agree --a alice.json --b bob.json --json
mf agree --a alice.json --b bob.json --min-agreement 0.9 --min-kappa 0.6
```

```
annotations: alice × bob
paired 18 · agree 16 · rate 88.9% · kappa 0.71
disagreements: 2
  c05: alice=create_html_report ≠ bob=file_read
```

- `--suite` 可选：额外报告套件里「两边都没标」的用例与「标注 id 不在套件里」的错误。
- `--min-agreement` / `--min-kappa`：低于阈值时退出码 2，可用于 CI 或发版门；
  默认 exit 0，只报告不阻断。
- 只有一边标注的 id 不计入一致性，会单独列出。

## 怎么读 kappa

一致率高不等于可靠：如果 95% 的用例都是同一个工具，两个人都答对它也会得到高一致率。
kappa 扣掉了这种「碰巧一致」：

| kappa | 解释（Landis & Koch） |
|---|---|
| < 0 | 比随机还差，说明标注规则本身有歧义 |
| 0 – 0.20 | 轻微 |
| 0.21 – 0.40 | 一般 |
| 0.41 – 0.60 | 中等 |
| 0.61 – 0.80 | 较强 |
| 0.81 – 1.00 | 几乎一致 |

当所有标注都落在同一类别时，期望一致率为 1，kappa 无定义（输出 `undefined`）；
此时看一致率本身，或补更多类别/负例。

## 建议流程

1. 两个人按同一份工具描述独立标注（`null` 也要明确写）；
2. `mf agree` 看一致率、kappa 与分歧清单；
3. 对每条分歧讨论并仲裁，记录改判理由（套件的 `judgments[]` 可留痕）；
4. 仲裁后的期望用 `mf case add --reviewed` 写入套件；只有复核过的用例才计入正式分数；
5. 把两份标注文件与套件一起存档，作为「判定可靠性」的证据。

## 边界

- 只比较 `expectedTool`（含 no-call），不比较 `expectedArgs`；
- 不做自动仲裁、不自动改期望；
- kappa 是统计描述，不是质量结论：规则歧义、描述歧义都会体现为低 kappa。
