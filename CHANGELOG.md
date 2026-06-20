# 更新日志

## v0.3.2（当前）

### 工具系统重构
- 改用 LangGraph 标准 `ToolNode` + `agent → tools → agent` 循环，移除手写节点路由和条件边
- `plan_steps → advance_step → exit_session` 三工具驱动所有结构化教学模式
- `plan_steps` 每次会话仅可执行一次（`updateTodo` 跳过已有 TODO 的二次调用）
- `switch_subject` 工具：模型可主动切换学科，自动播放渐变动画
- 所有结构化 prompt 接入 `switch_subject` 强制令

### 工具 UI 卡片
- 工具调用三态统一：pending（橙色 + 动画点）→ done（绿色 + CheckCircle）/ error（红色 + XCircle）
- pending/done/error 合并为单一模板，动态 `:class` 切换，不重建 DOM
- CSS transition 0.35s 平滑变色
- 卡片插入 `items` 数组，`todo_done` 时原地替换（同一 `v-for` key）
- 移除入场动画重播，dots 始终存在于 DOM（done/error 时 `opacity: 0` 渐隐）
- 知识图谱查询（`lookup_knowledge_point`）纳入同一卡片管理

### 学科切换
- 手动（SubjectSwitcher 标签栏）+ 模型自适应（`switch_subject` tool）混合模式
- 模型切换保留现有对话；手动切换仍创建新会话
- `subject_changed` 从 `on_chat_model_end` 的完整 args 发送（流式分片不触发）
- `todo_done(switch)` 延迟 800ms，等 CSS transition 播完再结束 pending
- `await nextTick()` 分离 DOM 更新与 subject 变更，确保 transition 不被合并跳过

### 侧边栏
- 品牌区域（logo + 版本 + 收起按钮）始终显示，不再随 `currentView` 隐藏
- 恢复原始 `transition-[width]` + Tailwind `w-64`/`w-0` 方案
- `borderRadius`/`boxShadow` 改为 `:style` 绑定 + `transitionProperty` 精确控制
- 双层渐变文字：`brand-text-bg`（固定色）+ `brand-text-overlay`（随 subject 变化，opacity 交叉淡变）

### 递归修复
- 过滤 `agent` 循环中重复追加的 system message
- `plan_steps` 指令从静态 prompt 移到动态 `todoAppend`（仅 TODO 为空时显示）
- `recursionLimit` 提升至 50

### 年级适配
- 高中：科学学科不可选（仅语数英）
- 大学：隐藏学科切换器 + 隐藏学习模式按钮 + 隐藏知识画像页面
- 知识图谱 `grade` 从 `authStore` 读取，变更时自动刷新

### 其他修复
- 专项练习二级菜单改用 Teleport + `position: fixed` 避免 `overflow:hidden` 裁剪
- `overflow-x:auto` 隐式设置 `overflow-y:auto` 修复（加 `overflow-y:visible`）
- 专项练习在通用模式下展示所有学科类型
- 发送消息即时向下滚动（force 模式跳过 `nextTick`+`rAF`）
- `finalizeAssistants` 自动过滤无正文的空 assistant 消息
- 删除对话先确认再退 session
- 探索课创建后加载到 chatStore
- `reviewTools` 重复展开导致 tool name 冲突 400 修复
- TikZ 模板加 `\usepackage{amsmath}` 支持 `\text{}`
- `$` 定界符自动闭合 + 正则 `\$(.+?)\$\$` 修复跨边界吞 `$`

---

## v0.3.1

- 画像树过滤教材导航章节节点
- 底部安全区域适配

## v0.3.0 — 移动端全面适配 + 知识图谱全量覆盖

### 移动端
- 响应式布局全面适配
- 侧栏会员标签 + 年级选择两步按钮
- 移除 QA 页右上角 UserMenu

### 课程知识图谱（G1-G9 全学科）
- 数学 1-9 全年级、语文 1-9 全年级、英语 3-9 主干 + 小学补充
- 浙教版初中科学 7-9 全部入库
- 知识点权重体系（核心/重要/标准/了解/拓展）
- 知识点 → 主题/素养/布鲁姆分类/前置依赖语义映射
- 数据库驱动的 question taxonomy（`knowledgePointId` 直连图谱节点）

### 考试系统全面优化
- 4 阶段并发流水线（蓝图→出题→审核→完成）
- 总分约束全链路嵌入（蓝图→出题→审核三级校验）
- 学科特定审核规则（数理 TikZ 校验 + 语文英语阅读量审核）
- `response_format` 替代 `bindTools`/`tool_choice`
- 大题导航 + 同组小题同页展示
- 题号轨道固定窗口 + 居中滚动动画
- 题号三态着色（未答/当前/已答）
- 选择题多选支持 + TiKZ 预渲染
- 填空题 `\boxed` → `\underline` 渲染优化
- 竖式（xlop）除法渲染 + 审核
- 出题/判卷标题 `brand-text` 渐变动画
- 答案端限额 + 每日用量环

### 用户设置
- 独立路由 `/setup`，彻底解决弹窗 backdrop 问题
- 字体大小三档调节（sm/md/lg）
- 模型提供商切换（DeepSeek V4 Flash / Pro）
- 所有卡片迁移 `.clay-glass` 毛玻璃效果
- 设置页双色球背景透过毛玻璃显示

### 熟练度系统
- Elo 评分 + 遗忘感知不确定性
- 指数移动平均替代简单累进
- 自适应 alpha（进步加速/退步减速）
- 非线性星映射（半星粒度）
- 星级变化动画过渡
- 各模式不同权重（预习 0.5 / 复习 1.0 / 突破 1.5 / 考试 2.0）
- 数据丰富度加权（无数据显示 0 星激励练习）

### 错题本
- 完整 CRUD + OCR 分析 + 风格特征 + 知识点映射
- 多题识别 + 学科自检测
- 按答案匹配度过滤
- 对话模式错题自动归集
- 双栏布局 + 富文本渲染
- LLM 标题生成
- 手动录入表单按题型自适应

### 知识画像
- 课程大纲可视化（按教材单元/章节/知识点）
- 综合熟练度大五星显示
- 学习诊断报告
- 章节小测 + 卷册测试按钮
- 非传统教学节点分类过滤（纯噪声过滤）
- 探索课 prompt 库 + 结构化 TODO prompt

### 探索课
- 20+ 探索主题（数学文化/科学探究/语文思辨）
- 结构化 TODO prompt + 评分解析
- API 端点 + 前端二次确认弹窗

---

## v0.2.2

- 滚动条轨道透明，不破坏背景沉浸感
- 考试页隐藏侧栏品牌 logo + 题号导航无边
- 清除 package.json BOM + SidebarLayout TS 类型断言
- 模型显示名 DeepSeek V4 Flash / Pro，去 emoji
- 用户 profile 按 userId 隔离
- 蓝图总分 <5% 偏差时微调题型数量精确命中目标分
- 英语阅读 passage 与 stem 重复显示自动去重
- 字体大小三档调节 + 滚动条 `scrollbar-gutter: stable`

## v0.2.1

- 初中年级标签初七→初一
- OAuth 回调 `router.replace` 修复双重渲染
- `authChecked` 前不展示主界面
- ChatView 多余 Transition 修复
- 考试页学科切换联动主题色（`:data-subject` 驱动 CSS 变量）
- `.clay-glass` 毛玻璃卡片体系
- 用户设置改为独立路由 `/setup`

## v0.2.0 — 结构化教学模式 + 考试系统

### 结构化学习模式
- 复习巩固模式（`complete_review` 工具）
- 预习模式 + 薄弱点突破模式
- 专项练习菜单（6 种工作流）
- 学习周期感知 + 模式切换工具（用户二次确认）
- 复习+快速巩固深度融合
- 各模式不同熟练度权重

### Todo 状态机
- `advance_step` 工具驱动步骤推进
- `exit_session` 工具退出类课堂
- 隐藏未完成步骤内容，强制 LLM 调 `advance_step` 解锁
- 每步耗时统计 + `todo_step` SSE 事件
- 步骤日志改用累积文本匹配，防 token 拆分漏检
- 跑马灯边框特效（`session-beam`）+ Teleport 修复裁切

### 类课堂冷色氛围
- `.boen-session` class 绑定 + CSS 变量覆盖（冷色 paper/ink/line）
- 广谱 `* { transition }` 全覆盖（0.7s）
- 光斑 opacity 补过渡
- 冷色覆盖层硬编码，根治跳变

### 出题系统
- 4 题型并行出题（选择/填空/判断/简答）
- 固定题分制（选择 3 分/填空 3 分/判断 2 分/简答 8 分）
- LLM 简答题评分 + 审核维度
- 年级段试卷结构知识库
- 多考点 `;` 分隔拆分匹配

### System Prompt 重写
- 吸收 Hermes Edu Skills 教学思想
- 通用学习方法嵌入各学科指引
- 强调必须用出题工具（否则数据不入库）
- 用户消息前显示模式标记

### 考试系统（初版）
- AI 自动生成试卷 + 在线作答 + 自动批改
- 成绩圆环显示百分比 + 揭晓动画
- 熟练度变化追踪 + 结果页展示
- 考试历史回顾页 + 侧栏三分区

### 其他
- 错题本初版（CRUD + OCR）
- 语音输入
- 吉祥物移至输入框右上角
- DeepSeek 默认模型
- ICP 备案号

---

## v0.1.1

- 修复吉祥物与消息重叠
- 修复题干 `<br>` 标签处理
- 知识点/素养标签标准化
- TikZ 根据提示词生成几何示意图
- 答题卡公式编辑器 MathLive

## v0.1.0

- 初始版本
- QA 模式流式对话
- Frost ID OAuth 登录
- 基本出题工具（选择题/填空/判断/简答）
- TikZ 图形渲染
- 年级感知适配（小学/初中/本科）
- 课程知识库基础设施（LangGraph RAG 集成）
