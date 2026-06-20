# 博文 Boen · 学习辅助智能体

面向 **小学 / 中学 / 本科** 三个年龄段的通用学习助手，基于 **LangGraph.js（全 TypeScript 栈）**。

支持日常问答、结构化预习/复习/练习、学科自适应切换、AI 出题批改、考试生成与评测。

> 线上体验：[boen.frostrain.tech](https://boen.frostrain.tech)

---

## 功能概览

### 日常问答（QA Mode）
- 任意学科自由提问，模型按年龄段调整语气与深度
- 苏格拉底式引导，优先帮用户自己推导而非直接给答案
- 流式输出 + LaTeX 公式 / TikZ 示意图实时渲染

### 结构化教学模式

所有结构化模式由统一的工具链驱动：

```
plan_steps → advance_step → exit_session
```

| 模式 | 说明 |
|------|------|
| 预习 | 建立知识框架、标记疑问点、准备课堂关注点 |
| 复习巩固 | 让学生自己讲、暴露盲区、针对性补充 |
| 薄弱点突破 | 诊断→基础重建→中等难度→综合巩固 |
| 专项练习 | 口算速练 / 字词听写 / 课文背诵 / 阅读理解 / 作文指导 / 单词学习 |
| 探索课 | 跨学科主题探索，教师引导式对话 |

### 出题与测评
- 四种题型：选择题（含多选）、填空、判断、简答
- 模型以 tool_call 结构化出题 → 前端渲染交互卡片
- 服务端判分（填空逐空给分，简答交 LLM 定性评分）
- 标准答案只留服务端，不下发前端

### 学科自适应切换
- 手动切换（右上角标签栏）+ 模型自动切换（`switch_subject` 工具）
- 模型检测到跨学科问题时自动切换学科 + 更新知识库
- 切换时 CSS transition 平滑变色（光斑 + UI 元素）

### 年级适配
| 年级 | 可选学科 | 结构化模式 | 知识画像 |
|------|---------|-----------|---------|
| 小学 1-6 | 语数英科 | ✅ | ✅ |
| 初中 7-9 | 语数英科 | ✅ | ✅ |
| 高中 | 语数英（无科学） | ✅ | ✅ |
| 大学 | 通用对话（无学科绑定） | ❌ | ❌ |

### 考试系统
- AI 自动生成试卷（按知识点/题型/难度）
- 在线作答 + 自动批改 + 成绩分析
- 错题本 + 薄弱点推荐练习

### 知识画像
- 知识点熟练度追踪（Elo 评分 + 遗忘感知）
- 课程大纲可视化（按教材单元/章节/知识点）
- 掌握度星级展示

---

## 技术栈

| 层 | 选型 |
|---|---|
| 智能体编排 | LangGraph.js（`@langchain/langgraph`） |
| 模型适配 | `@langchain/openai`（OpenAI 兼容）/ `@langchain/anthropic`（Claude） |
| 后端 | Hono + `@hono/node-server`，SSE 流式 |
| 前端 | Vue 3 + Vite + Tailwind v4 + markdown-it + KaTeX |
| 图形渲染 | PGF/TiKZ → xelatex → dvisvgm 服务端编译 |
| 知识库 | MySQL + 自定义课程知识图谱（G1-G9 全学科） |
| 公式编辑 | MathLive（所见即所得） |
| 包管理 | npm workspaces（monorepo） |

## 目录结构

```
boen/
├── packages/
│   ├── shared/          # 前后端共享类型（SseEvent / GradeBand / ChatRequest …）
│   ├── agent-core/      # 模型工厂 + LangGraph 主图 + 工具定义 + 课程工具
│   └── quiz/            # 出题批分子系统
├── apps/
│   ├── server/          # Hono SSE 后端（聊天/考试/画像/探索 API）
│   └── web/             # Vue 3 前端
└── script/              # 数据分析、课程数据导入脚本
```

## LangGraph 图结构

```
__start__ → router → loadCurriculum → agent
agent → ToolNode(有 tool_calls) → updateTodo → agent
agent → __end__(无 tool_calls)
```

- **router**: 用户意图检测 → 设置 `mode`（qa / review / preview / weakness / practice / explore）
- **loadCurriculum**: 按学科+年级加载课程知识库
- **agent**: 构建 system prompt + 绑定工具 → 调用 LLM
- **tools**: `ToolNode` 自动执行所有工具调用
- **updateTodo**: 拦截 `plan_steps`/`advance_step` 维护 TODO 状态机

## 工具清单

| 工具 | 说明 |
|------|------|
| `plan_steps` | 模型根据学习内容自定 TODO 步骤（≥3 步），每次会话仅可调用一次 |
| `advance_step` | 推进到下一步（需学生确认） |
| `exit_session` | 结束类课堂学习，提交总结和评分 |
| `switch_subject` | 切换当前教学学科（模型自适应） |
| `ask_multiple_choice` | 出选择题（含多选） |
| `ask_fill_blank` | 出填空题 |
| `ask_true_false` | 出判断题 |
| `ask_short_answer` | 出简答题 |
| `complete_review` | 复习完成提交评分 |
| `lookup_knowledge_point` | 查询课程知识图谱 |
| `switch_to_*` | 学习周期感知主动建议切换模式 |

## 配置

复制 `.env.example` 为 `.env` 并填写：

```env
BOEN_PROVIDER=openic          # openai（兼容）| anthropic
BOEN_MODEL=deepseek-v4-flash
BOEN_BASE_URL=https://api.deepseek.com
BOEN_API_KEY=你的key
PORT=8787
```

换模型只需改 `.env`：换 OpenAI 兼容厂商改 `BASE_URL/MODEL/KEY`；用 Claude 把 `PROVIDER` 设为 `anthropic`。

## 运行

```bash
npm install                    # 根目录，一次装齐所有 workspace 依赖

npm run dev:server             # 启动后端 → http://localhost:8787
npm run dev:web                # 启动前端 → http://localhost:5173
```

健康检查：`curl http://localhost:8787/api/health`

## API

主要端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/chat` | POST | 流式对话（SSE） |
| `/api/answer` | POST | 提交题目作答 |
| `/api/explore` | POST | 启动探索课 |
| `/api/exam/generate` | POST | 生成考试 |
| `/api/exam/submit` | POST | 提交考试答案 |
| `/api/profile/report` | GET | 学习画像报告 |
| `/api/profile/outline` | GET | 课程大纲 |
| `/api/render-tikz` | POST | TikZ → SVG 渲染 |
| `/api/model/status` | GET | 当前模型状态 |
| `/api/ai/*` | - | AI 相关（观澜模式） |

详细接口定义见 `packages/shared/src/index.ts` 中的 `SseEvent` 类型。

## 年级系统

```typescript
type Grade = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'high' | 'college';
type GradeBand = 'primary' | 'middle' | 'undergrad';
```

`gradeToBand` 映射：1-6 → primary，7-9 → middle，high → middle，college → undergrad。

## 部署

### 云端结构（阿里云）

- 代码 `/var/www/boen`，git 检出自 `github.com:Frostrain5015/Boen.git`
- nginx 站点 `/etc/nginx/sites-available/boen`：静态托管 `/apps/web/dist`，`/api` 反代到 `127.0.0.1:8787`
- 后端 pm2 进程 `boen-server`

### 部署步骤

```bash
cd /var/www/boen
git fetch origin main && git reset --hard origin/main
npm install
cd apps/web && npm run build
pm2 restart boen-server
```

## License

MIT
