# 博文 Boen · 学习辅助智能体

面向**小学 / 中学 / 本科**三个年龄段的通用学习助手，基于 **LangGraph.js（全 TypeScript 栈）**。

规划三大功能：
1. **日常答疑** —— 按年龄段适配用词与深度，作业题优先引导思路。✅ 阶段 0 已跑通
2. **系统复习** —— 对一本书 / 一个知识点做知识梳理 + 原创考题（RAG）。🔜 阶段 2
3. **新型 AI 学习** —— 场景模拟对话、角色扮演 + 学习复盘。🔜 阶段 3

## 技术栈

| 层 | 选型 |
|---|---|
| 智能体编排 | LangGraph.js（`@langchain/langgraph`） |
| 模型适配 | `@langchain/openai`（OpenAI 兼容）/ `@langchain/anthropic`（Claude），可插拔工厂 |
| 后端 | Hono + `@hono/node-server`，聊天走 SSE 流式 |
| 前端 | Vue 3 + Vite + Tailwind v4 + markdown-it |
| 包管理 | npm workspaces（monorepo） |

## 目录结构

```
boen/
├── packages/
│   ├── shared/       # 前后端共享类型（ChatRequest / SseEvent / GradeBand …）
│   └── agent-core/   # 模型工厂 + LangGraph 主图（router → qa，后续挂 review / ai-learning 子图）
└── apps/
    ├── server/       # Hono SSE 后端：POST /api/chat、GET /api/health
    └── web/          # Vue 聊天前端
```

主图当前形态：`__start__ → router → qa → __end__`，共享状态 `{ messages, gradeBand, mode }`，
带 `MemorySaver` 检查点实现按 `threadId` 的多轮记忆。后续在 router 后按 `mode` 分流到三个子图。

## 配置

复制 `.env.example` 为 `.env` 并填写：

```env
BOEN_PROVIDER=openai          # openai（OpenAI 兼容）| anthropic
BOEN_MODEL=astron-code-latest
BOEN_BASE_URL=https://maas-coding-api.cn-huabei-1.xf-yun.com/v2
BOEN_API_KEY=你的key           # OpenAI 兼容厂商一般用完整 key 作为 Bearer
PORT=8787
```

> 换模型只需改 `.env`：换 OpenAI 兼容厂商改 `BASE_URL/MODEL/KEY`；用 Claude 把 `PROVIDER` 设为 `anthropic`。

## 运行

```bash
npm install            # 根目录，一次装齐所有 workspace 依赖

npm run dev:server     # 启动后端 → http://localhost:8787
npm run dev:web        # 启动前端 → http://localhost:5173（/api 已代理到后端）
```

健康检查：`curl http://localhost:8787/api/health`

## API

两个端点均返回 `text/event-stream`，每帧 `data: <SseEvent JSON>`。

**`POST /api/chat`** — 一轮对话
```jsonc
{ "threadId": "abc", "message": "什么是光合作用？", "gradeBand": "primary" }
// 事件：{type:'token',value} ... {type:'question',toolCallId,question} ... {type:'done'} / {type:'error'}
```

**`POST /api/answer`** — 提交一道题的作答
```jsonc
{ "threadId": "abc", "toolCallId": "call_xxx", "answer": { "type": "multiple_choice", "selectedKeys": ["A"] } }
// 事件：{type:'grading',toolCallId,result} → {type:'token',...}(模型点评) → 可能再 {type:'question'} → {type:'done'}
```

### 测评（answer card）模块 —— 可复用的对话内嵌答题

四种题型工具：`ask_multiple_choice`（含多选）/ `ask_fill_blank` / `ask_true_false` / `ask_short_answer`。

- 模型以 **tool_call**（结构化）出题 → 服务端剥离标准答案后推 `question` 事件 → 前端渲染**交互卡片**。
- 用户作答 → `POST /api/answer` → **服务端判分**（填空题逐空给分；简答题交模型定性）→ `grading` 事件 + 模型点评。
- **标准答案只留在服务端**，不下发前端。
- router 识别「考我/出题/判断题/填空题…」意图时**强制指定题型工具**（该模型不支持 `tool_choice:"required"`，改用按函数名强制）；判分反馈轮**不绑定工具**以保证给出文字点评。
- 该接口设计为高频复用：阶段 2 系统复习、阶段 3 AI 学习均直接调用。

## 路线图

- [x] **阶段 0**：骨架 + 答疑跑通（流式、年龄段适配、多轮记忆）
- [ ] **阶段 1**：答疑增强（工具、苏格拉底引导开关）
- [ ] **阶段 2**：系统复习（文档入库 + RAG + 知识点梳理 + 原创出题 + 错题本）
- [ ] **阶段 3**：AI 学习（场景对话子图 + 学习复盘）
- [ ] **阶段 4**：用户画像、复习进度、前端三页面、评测
