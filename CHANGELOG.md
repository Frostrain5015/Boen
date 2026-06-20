# 更新日志

## v0.3.2（2026-06-20）

### 工具系统重构
- 改用 LangGraph 标准 `ToolNode` + `agent → tools → agent` 循环，移除手写节点路由
- `plan_steps → advance_step → exit_session` 三工具驱动所有结构化教学模式
- `plan_steps` 每次会话仅可执行一次，不可重复覆盖 TODO
- `switch_subject` 工具：模型可主动切换学科，自动播放渐变动画

### 工具 UI
- 工具卡片三态统一：pending（橙色 + 动画点）→ done（绿色 + CheckCircle）/ error（红色 + XCircle）
- 卡片插入 `items` 数组，状态变更原地替换不重建 DOM，无入场动画重播
- 知识图谱查询（`lookup_knowledge_point`）纳入同一卡片管理
- 工具调用处切分消息，结果单独占一条完整记录

### 学科切换
- 手动 + 模型自适应混合模式
- 模型切换保留现有对话（不新建），手动切换仍创建新会话
- `transition-[width]` 恢复原始方案修复侧边栏展开平滑动画
- `.app-bg` 背景完全硬编码，gradient 不再随 subject 变化 → 零 snap
- 光斑 `background: var(--accent)` + `transition: background 0.7s ease` 独立帧触发

### 递归修复
- 过滤 `agent` 循环中重复追加的 `system` message，防止 context 膨胀
- `plan_steps` 指令从静态 prompt 移到动态 `todoAppend`，TODO 创建后指令消失
- `recursionLimit` 提升至 50

### 其他修复
- 专项练习二级菜单改用 Teleport 避免 `overflow:hidden` 裁剪
- 侧边栏品牌区常驻显示 + 双层渐变文字（`brand-text-bg` + `brand-text-overlay`）
- 发送消息即时向下滚动（force 模式跳过 `nextTick`+`rAF`）
- 自动过滤无正文的空 assistant 消息
- CSV tool name 冲突修复
- TikZ 模板加 `\usepackage{amsmath}` 支持 `\text{}`
- `$` 定界符自动闭合 + 正则修复跨边界吞 `$`

---

## v0.3.1（2026-06-17）

- 画像树过滤教材导航章节节点
- 底部安全区域适配 + 移动端布局微调

## v0.3.0（2026-06-15）

- 移动端全面适配（响应式布局、触控优化）
- 模式按钮区域重构
- 侧栏会员标签 + 年级选择两步按钮

---

## v0.2.2（2026-06-10）

- 滚动条轨道透明，不破坏背景沉浸感
- 考试页隐藏侧栏品牌 logo
- 题号导航无边框优化

## v0.2.0（2026-05-28）

- LLM 简答题评分（`ask_short_answer`）
- 复习模式重构（`complete_review` 工具）
- 考试分析（`analyze_exam` 工具）
- 四种题型并行出题
- 默认模型切换到 DeepSeek
- 成绩揭晓动画 + 隐藏分数预览
- 得分圆环显示百分比
- 熟练度指数移动平均

## v0.1.1（2026-05-10）

- 修复吉祥物与消息重叠
- 修复题干中的 `<br>` 标签处理
- 知识点/素养标签标准化

## v0.1.0

- 初始版本
- QA 模式流式对话
- Frost ID OAuth 登录
- 基本出题工具（选择题/填空/判断/简答）
- TikZ 图形渲染
- 年级感知适配（小学/初中/本科）
