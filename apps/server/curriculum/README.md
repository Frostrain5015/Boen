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

义务教育 1–9 年级 语文/数学/英语 + 小学(1–6)科学。初中科学（物/化/生分科）暂不收录。
