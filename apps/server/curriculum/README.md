# 课程知识库源数据（人教版）

本目录存放结构化的教材大纲源数据，`npm run seed:curriculum --workspace @boen/server` 读取后入库并计算向量。

seed 后可运行：

```bash
npm run verify:curriculum --workspace @boen/server -- 7 math 一元一次方程
```

验证指定年级/学科是否已有教材、章节、知识点、向量、来源 URL，以及 LangGraph 工具用的知识点查询是否可用。

## 文件格式

每个 `.json` 文件是一册教材（`TextbookSeed`）或其数组。字段见 `src/curriculum.ts` 的 `TextbookSeed`：

```jsonc
{
  "subject": "math",            // chinese | math | english | science
  "grade": "7",                 // '1'..'9'
  "volume": "上册",              // 上册 | 下册 | 全册
  "publisher": "人教版",
  "version": "2024",            // 教材版本/年份
  "sourceUrl": "https://...",   // 数据来源，务必填写以便核对
  "units": [
    {
      "title": "第一章 有理数",
      "kind": "chapter",
      "knowledgePoints": ["正数和负数", "数轴"],   // 按 title 关联知识点（多对多）
      "children": [
        { "title": "1.1 正数和负数", "kind": "section" }
      ]
    }
  ],
  "knowledgePoints": [          // 该册涉及的知识点条目（供按薄弱点自适应辅导）
    { "title": "正数和负数", "description": "用正负数表示相反意义的量", "code": "" },
    { "title": "数轴", "description": "数轴的三要素与数形对应" }
  ]
}
```

## 命名约定

`{subject}-g{grade}-{volume}.json`，如 `math-g7-上册.json`。

## 数据准确性

**必须基于权威来源**（人教社电子课本目录 pep.com.cn / 教育部 2022 课标），逐册核对，`sourceUrl` 必填。**严禁凭记忆编造**。

当前小样：

- `math-g7-上册.json`：来源为人教社官方「数学 七年级上册/义务教育教科书」教材介绍页，目录条目按页面目录整理。

## 范围（当前）

语文、数学、英语覆盖义务教育 1–9 年级；科学覆盖 1–9 年级，其中初中科学采用浙教版科学课程结构。每册可用性以已提交源数据、`sourceUrl` 与 `verify:curriculum` 校验结果为准。

## 外部课程资料

`npm run import:external-curriculum -w @boen/server -- <来源> <数据版本> <本地绝对目录>` 按来源生成独立 SQLite 文件，默认位于 `apps/server/data/external-curriculum/`。导入成功后才替换旧文件。导入器保留原始文件、SHA-256、来源 ID、版本和许可，校验先修边的端点及必需依赖环。可加 `--no-vectors` 只建立关键词索引，或用 `--output-dir <目录>` 在独立目录验证。

| 来源 | 本地输入 | 许可 |
| --- | --- | --- |
| `marble` | `topics.json`、`dependencies.json`、`LICENSE`、`LICENSE-CONTENT`、`PROVENANCE.md` | ODbL 1.0 / CC BY-SA 4.0，随库保留许可与署名。第三方课标原文文件另按来源授权。 |
| `k12-kgraph` | `K12-KGraph/` 目录（`global_KG/` 和可选的 `subject_specific_KG/`），也支持直接给出全局 `nodes.json`、`edges.json` 的目录 | CC BY-NC-SA 4.0，取得商用授权后以 `--authorization <记录编号>` 导入。 |
| `cn-math-taxonomy` | `topics.json`、`dependencies.json` | CC BY-NC 4.0，取得商用授权后以 `--authorization <记录编号>` 导入。 |

已安装的外部库会按学科和年级为教材检索补充知识点与直接先修关系。Marble 的年龄段作为小学检索范围的近似值。中文问题先由现有查询改写模型提炼英文教材术语，再进行关键词或多语言向量检索。章节和进度以博文教材为准。公开使用 Marble 时，可通过 `/api/curriculum/sources/marble` 下载独立数据库及其中的许可文件。外部库独立于教材目录和学生掌握度。题库、评测集和训练集不在此导入范围。
