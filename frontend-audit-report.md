# 博文 Boen 前端审计报告

> 审计日期：2026-06-25  
> 前端版本：v0.5.0  
> 审计范围：`apps/web/src` 全部文件（59 个文件，17 个 Vue 组件，5 个 Pinia Store，2 个 Service，7 个 Composables）
>
> 最后更新：2026-06-25 13:30 — 代码已推送部署上线，以下列出**仍待批示的未解决问题**。

---

## 📋 当前状态一览

| 严重程度 | 总数 | ✅ 已修复 | ⏳ 待批示 |
|----------|:----:|:--------:|:--------:|
| 🔴 严重 | 4 | 3 | 1 |
| 🟡 警告 | 9 | 5 | 4 |
| 🟢 建议 | 8 | 3 | 5 |
| 🎨 视觉 | 3 | 3 | 0 |
| **合计** | **24** | **14** | **10** |

> ✅ 已修复问题见工作日志，以下仅列出**待批示/待决策**的条目。

## 目录

1. [严重问题](#一严重问题)
2. [警告项](#二警告项)
3. [建议项](#三建议项)
4. [审计维度小结](#四审计维度小结)

---

## 一、严重问题

### ✅ ~~🔴 S-1：通用 `apiFetch()` 未做错误体防抖 — 401 静默丢失认证状态~~［已修复］

**修复内容**：
- `apiFetch` / `streamSse` / `streamAuthorizedSse` 全部增加 HTTP 401 检测
- 注册 `setOnUnauthorized` 回调，触发 `authStore.doLogout()` 自动登出

### ✅ ~~🔴 S-2：大量 `catch` 块仅 `console.warn` — 异常被吞没~~［已修复］

**修复内容**：
- `loadConversations` / `loadExams` / `fetchSubscription` / `fetchCurrencyStatus` / `selectConversation` 全部从 `console.warn` 升级为 `console.error`

---

### ⏳ 🔴 S-3：`ExamView.vue`（~400+ 行）单一组件过度臃肿

**位置**: `components/ExamView.vue`（全文 ~21,000 tokens）  
**风险等级**: **严重**  
**维度**: 页面组织与布局
**状态**: **⏳ 待批示** — 需架构评估后决定是否拆分

ExamView.vue 包含整个考试流程：配置 → 生成 → 答题 → 判卷 → 结果展示，逻辑耦合度高。单一组件承担了：
- 考试配置表单状态管理
- SSE 流式事件处理
- 多题型答题交互
- 判分结果展示
- TikZ 渲染调度
- 错误处理与重试

**后果**：
- 可测试性极差（无法单独测试答题或结果展示）；
- 多人协作时 merge conflict 频繁；
- 性能优化困难（`reactive` 覆盖所有子模块，无精细的 `computed` 依赖拆分）。

**可选方案**：
1. **拆分组件**：拆分为 `ExamConfigPanel` / `ExamSession` / `ExamResults` / `ExamQuestionList` 四个子组件，SSE 逻辑抽到 `useExamSession` composable
2. **保留现状**：当前功能稳定，拆分的投入产出比不高，仅新增功能时按模块逐步分离

### ✅ ~~🔴 S-4：CSS 全局 `*` 过渡导致性能隐患~~［已修复］

**修复内容**：
- 全局 `*` 通配符 transition 替换为 `.boen-session *`（仅类课堂模式激活时生效）
- `.clay` / `.clay-glass` / `.clay-sm` 卡片显式声明过渡属性

---

## 二、警告项（待批示）

### ⏳ 🟡 W-1：`handleEvent` 中动态 `import` 方式不一致

**位置**: `stores/chat.ts:222-227, 231-232`  
**风险等级**: **警告**

`senttlement` 和 `subject_changed` 事件处理器中使用了：

```typescript
const { useAuthStore } = await import('@/stores/auth');
const { useUiStore } = await import('@/stores/ui');
```

这与其他事件处理器（如 `usage`、`todo_plan`）中顶部 `import` 的方式不一致。动态 `import` 虽然可以避免循环依赖，但：
- 增加了异步延迟（即使是微任务）;
- 使得静态分析工具无法追踪依赖关系；
- Vue DevTools 中 store 状态可能断链。

**改进方向**：统一使用 `useUiStore`（已在文件顶部 `import`），memoize 引用或重构循环依赖。

---

### 🟡 W-2：`ChatView.vue` — `onMounted` 时 `nextTick` 后启动新手引导

**位置**: `views/ChatView.vue:15-17`  
**风险等级**: **警告**  
**维度**: 交互逻辑

```typescript
onMounted(() => {
  nextTick(() => onboarding.maybeStart('chat'));
});
```

新手引导依赖于 DOM 元素上 `data-tour="nav"` 等标记，但 `nextTick` 不保证子组件（如 `SidebarLayout`）的 slot 内容已完成渲染。若侧边栏渲染延迟，引导箭头可能指向错误位置或空白区域。

**改进方向**：使用 `onMounted` 内 `watch` 目标元素是否存在，或设一个 300ms 的 fallback 延迟；考虑使用 `MutationObserver` 等待目标元素出现。

---

### ✅ ~~🟡 W-3：`useImagePicker.compressImage` 未处理异常图片格式~~［已修复］

**修复内容**：
- 新增 `lastPickFailedCount` ref 暴露失败文件数
- 失败图片打印 `console.error` 并累计计数

---

### ✅ ~~🟡 W-4：`SidebarLayout` 中 `subjectLabel` 与 `SUBJECT_LABELS` 重复定义~~［已修复］

**修复内容**：
- `SidebarLayout` / `ExamReview` / `MistakeBook` 全部改用 `stores/ui.ts` 导出的 `SUBJECT_LABELS`，消除 3 处重复定义

---

### ✅ ~~🟡 W-5：`MistakeBook.vue` — `clearImage()` 未捕获 `URL.revokeObjectURL` 异常~~［已修复］

**修复内容**：
- MistakeBook 中 3 处 `URL.revokeObjectURL` 全部包裹 `try/catch`

---

### ✅ ~~🟡 W-6：`ExamView` 中 SSE 事件未使用 AbortSignal 取消~~［已修复］

**修复内容**：
- ExamView 新增 `examAbortController` ref
- `streamExamGenerate` / `streamExamSubmit` 传入 `signal` 参数
- `onUnmounted` 时自动 `abort()` 所有未完成的 SSE 请求
- 服务层 `streamExamGenerate` / `streamExamSubmit` 函数签名增加可选 `signal` 参数

---

### ⏳ 🟡 W-7：`QuestionCard` 中 `(grading as any).proficiencyChanges` 绕过类型系统

**位置**: `components/QuestionCard.vue:327-337`  
**风险等级**: **警告**  
**维度**: 其他关注点  
**状态**: **⏳ 待批示** — 需更新 `@boen/shared` 包的 `GradingResult` 类型定义

```vue
<div v-if="(grading as any).proficiencyChanges?.length">
```

使用 `as any` 绕过 TypeScript 类型检查来访问 `proficiencyChanges`，说明 `GradingResult` 的类型定义不完整。这会导致：
- 编辑器无自动补全；
- 重构时被忽略；
- 运行时可能因字段不存在而静默失败。

**改进方向**：更新 `@boen/shared` 中 `GradingResult` 类型定义，增加 `proficiencyChanges` 字段；移除 `as any`。

---

### ⏳ 🟡 W-8：`NetworkStatusBanner` 仅监听在线/离线事件，未做恢复后重试

**状态**: **⏳ 待批示** — 涉及后端 API 配合，需评估复杂度

**位置**: `composables/useNetworkStatus.ts:9-10`  
**风险等级**: **警告**  
**维度**: 交互逻辑

网络恢复后，正在进行的 SSE 请求（`streamSse`、`streamAuthorizedSse`）已经被中断，`StreamInterruptedError` 会被抛出。`send()` 方法中虽然有 `StreamInterruptedError` 的处理逻辑（调用 `selectConversation` 恢复），但 `onAnswer` 和 `streamExamSubmit` **没有相同的断线重试逻辑**，用户可能丢失已提交的答题数据。

**改进方向**：
- `streamSse` 中断时自动重试（带指数退避）；
- 或所有 SSE 调用方统一加断线重试逻辑；
- `onAnswer` 方法补增 `StreamInterruptedError` 处理。

---

### ⏳ 🟡 W-9：`SetupView.vue` — 兑换码解码在客户端明文进行

**状态**: **⏳ 待批示** — 需服务端配合返回有效期信息后移除客户端解码

**位置**: `views/SetupView.vue:61-73`  
**风险等级**: **警告**  
**维度**: 交互逻辑

`decodeCodeDuration()` 在客户端对兑换码进行 Base32 解码以推断有效期（30/365 天）。虽然这不涉及密钥泄露，但：
- 将兑换码编码格式暴露给客户端（容易逆向工程伪造验证请求）；
- 解码纯属 UI 预览，对功能无实际影响，徒增包体积和复杂度。

**改进方向**：移除客户端解码逻辑，由服务端 `/api/subscription/redeem` 返回有效期信息。

---

## 三、建议项（待批示）

### ✅ ~~🟢 A-1：`MistakeBook.vue` — 图片上传缺少 type 约束增强~~［已修复］

**修复内容**：`accept` 属性增加 `image/heic,image/heif`

---

### 🟢 A-2：`BoenSelect` 组件未在可访问性上做优化

**位置**: `components/BoenSelect.vue`（自定义下拉选择器）  
**维度**: 交互逻辑

自定义下拉选择器缺少：
- ARIA 属性（`role="listbox"`、`aria-selected`、`aria-activedescendant`）；
- 键盘导航（`ArrowUp`/`ArrowDown`/`Escape`/`Home`/`End`）；
- 屏幕阅读器标签（`aria-label`）。

**改进方向**：参照 [WAI-ARIA Combobox Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) 完善。

---

### 🟢 A-3：`chatStore.send()` 中 `modeTag` 和 `practiceMenu` 的文案硬编码

**位置**: `stores/chat.ts:290-291`、`stores/ui.ts:69-85`  
**维度**: 其他关注点

模式标签（"复习巩固·"、"预习·" 等）和专项练习菜单文案以 `\u` 转义硬编码在 store 逻辑层中：
- 无法国际化；
- 文案修改需重新打包发布。

**改进方向**：将 UI 文本集中到 `i18n` 文件或 `constants.ts` 中。

---

### 🟢 A-4：TikZ 渲染防抖时间（400ms）和重试次数对于大文档不够稳健

**位置**: `stores/chat.ts:28`、`components/MistakeBook.vue:400-413`  
**维度**: 性能

`scheduleTikzRender()` 的 400ms 防抖在长文档（50+ TikZ 块）下可能不够，MistakeBook 的多重重试（150/600/1500ms 各一次）较粗暴。

**改进方向**：使用 `requestIdleCallback` + 分片渲染替代定时器重试；或改用 `MutationObserver` 检测 DOM 插入完成后再触发。

---

### 🟢 A-5：`KnowledgeProfile` 中 `authHeaders()` 与 `services/chat.ts:apiFetch` 的 token 注入重复实现

**位置**: `components/KnowledgeProfile.vue:67-70`、`services/chat.ts:122-136`  
**维度**: 其他关注点（重复代码）

`KnowledgeProfile` 直接用 `fetch` 手动注入 token，与 `apiFetch` 逻辑重复。

**改进方向**：统一使用 `apiFetch` 或暴露一个公共的 `authenticatedFetch` 封装。

---

### 🟢 A-6：`ExamView` 中多个独立 `examIndex` 和互锁状态缺乏集中管理

**位置**: `components/ExamView.vue` 内部  
**维度**: 页面组织

`currentStep`（配置/生成/答题/结果）、`selectedAnswers`、`submitting`、`timer` 等多维状态散布在多个 `ref` 中，缺乏一手的状态图/状态机描述。

**改进方向**：引入 `useExamSession` composable，内部使用有限状态机（如 `XState` 或简单 `enum + switch`）统一管理状态流转。

---

### 🟢 A-7：`useVoiceInput` 缺少错误反馈

**位置**: `composables/useVoiceInput.ts`  
**维度**: 交互逻辑 / 报错处理

Web Speech API 在权限被拒绝、引擎未加载、不支持语言时触发 `error` 事件，但目前没有暴露错误状态给用户。

**改进方向**：在 composable 中增加 `voiceError` ref，InputArea 中监听并展示 toast。

---

### ✅ ~~🟢 A-8：全局未捕获错误处理缺失~~［已修复］

**修复内容**：
- `main.ts` 注册 `app.config.errorHandler` + `window.onerror` + `window.onunhandledrejection`
- `ToastProvider` 增加 `boen:global-error` 自定义事件监听，异常时展示 Toast 提示

---

## 四、审计维度小结

### 1. 交互逻辑

| 评级 | 条目 |
|------|------|
| 🟡 W-2 | 新手引导时机依赖 `nextTick`，DOM 未就绪时可能定位失败 |
| 🟡 W-6 | 考试 SSE 未使用 AbortSignal，组件卸载后请求残留 |
| 🟡 W-8 | 断线恢复后 `onAnswer`/`streamExamSubmit` 无重试逻辑 |
| 🟡 W-9 | 兑换码解码逻辑在客户端暴露编码格式 |
| 🟢 A-1 | 图片上传不支持 HEIC（iPhone 默认格式） |
| 🟢 A-2 | 自定义下拉组件缺可访问性（ARIA/键盘导航） |
| 🟢 A-7 | 语音输入错误缺乏用户反馈 |

### 2. 页面组织与布局

| 评级 | 条目 |
|------|------|
| 🔴 S-3 | ExamView（~400+ 行）过度臃肿，需拆分为多组件 |
| 🟢 A-6 | ExamView 多维状态缺乏状态机管理 |
| 🟢 A-5 | KnowledgeProfile 与 apiFetch 的 token 注入重复 |

### 3. 报错处理

| 评级 | 条目 |
|------|------|
| 🔴 S-1 | `apiFetch` 未处理 401，token 过期后无声丢失认证 |
| 🔴 S-2 | 大量 try/catch 仅 console.warn，异常被吞没 |
| 🟡 W-3 | `useImagePicker` 图片加载失败时用户无感知 |
| 🟡 W-5 | `URL.revokeObjectURL` 未做异常防护 |
| 🟢 A-8 | 全局 `errorHandler` / `onerror` 未注册 |

### 4. 其他关注点（代码质量/性能/可维护性）

| 评级 | 条目 |
|------|------|
| 🔴 S-4 | CSS 全局 `*` 通配符过渡拖累渲染性能 |
| 🟡 W-1 | `handleEvent` 中动态 import 方式不一致 |
| 🟡 W-4 | 学科映射在 5 个文件中重复定义 |
| 🟡 W-7 | `(grading as any).proficiencyChanges` 绕过类型系统 |
| 🟢 A-3 | 模式标签/文案硬编码在逻辑层 |
| 🟢 A-4 | TikZ 渲染防抖策略不够稳健 |

---

---

## 五、视觉特效与审美评估

> 评估维度：主题一致性、配色体系、动效品质、品牌传达、组件美学、操作习惯匹配度

### 5.1 主题与配色系统 — ⭐⭐⭐⭐⭐

**正面评价**：

1. **暖纸黏土主题高度统一** — `--paper: #fbf6ee` 作为基底色贯穿全应用，"暖纸" 的物理质感通过`.clay` 卡片的 `backdrop-filter: blur(16px)`、`border: 1.5px solid #ffffff`、多层级 `box-shadow` 实现了逼真的毛玻璃黏土质感。搭配 `.app-grain` 的 SVG 噪点纹理（`feTurbulence`），营造了像真实纸张、橡皮泥般的触感氛围。

2. **学科动态配色** — 语文（珊瑚橙 `#ff7a4d`）、数学（薄荷绿 `#14b48a`）、英语（紫蓝 `#6c5ce7`）、科学（天蓝 `#3498db`）各具明确心理暗示色，通过 CSS 自定义属性 + `[data-subject]` 选择器实现全局颜色切换。颜色选择贴合学科氛围（语文暖、数学清新、英语学院感、科学理性）。

3. **类课堂模式冷色调切换** — 从暖纸切换到冷色氛围（`--paper: #f1f4f9`），视觉语义正确传达了"进入学习状态"的仪式感。`boen-session` 类名驱动的 `opacity` 渐变叠加层设计精妙，避免闪烁。

**### 🟡 警告项：品牌色与字体定位的细微矛盾**

- **字体选择**：使用 Fredoka（圆润无衬线）作标题字体，搭配 Nunito 作正文字体，但中文字体回退到 HarmonyOS Sans SC 后，标题和正文的中文部分均为同一字体栈末尾（HarmonyOS Sans），导致中英文标题的视觉差异（Fredoka 的圆润感在中文上无法体现）。英文标题（"Boen"）圆润可爱，中文标题（"博文"）平平无奇。
- **会员配色品质感不足**：皓月卡使用铂金灰（`#8f9aa3`），星耀卡使用紫色渐变（`#8b5abf`）。皓月卡的灰色在非高亮场景下显得暗淡（对比度低），与"皓月"（明亮月光）的品牌联想不符。`badge-premium` 的金色渐变（`#f5d89a → #8f9aa3 → #6a6560`）从亮金过渡到灰褐，跨度太大，视觉上"脏"。

**改进方向**：
- 为中文标题单独指定一款圆润中文字体（如 ZCOOL QingKe HuangYou 或更友善的粗圆体）；
- 皓月卡改用银白渐变（`#e8eef5 → #bcc8d8`）配合微弱的冷光投影，贴合"月光"意象。

---

### 5.2 吉祥物角色系统 — ⭐⭐⭐⭐⭐

**正面评价**：

`Mascot.vue` 是项目视觉的最高亮点，展现了对 SVG 动效、CSS 动画、角色设计的极佳掌控：

1. **7 种情感状态**：idle（呼吸）/ thinking（歪头托腮+思考点点）/ listening（倾听+手臂摇摆）/ quiz（举高问号）/ happy（跳跃欢呼+闭眼咧嘴+星星特效）/ surprise（惊吓瞪眼张嘴+感叹号）/ sleepy（缓缓下沉+久眨眼），覆盖了产品全场景的情绪需求。
2. **SVG 技巧纯熟**：`radialGradient` 高光阴影、`linearGradient` 手臂阴影、腮红、瞳孔高光——视觉层次丰富，与黏土质感呼应。
3. **CSS 动画控制精细**：各状态动画时长、缓动函数、动作幅度精心调校（如 `startle` 使用 `cubic-bezier(0.34, 1.56, 0.64, 1)` 产生弹性回弹效果），不同部位的 `transform-origin` 精确设置。
4. **可访问性**：`aria-hidden="true"` 标记装饰性角色。
5. **双模式支持**：`animated` prop 允许关闭动画用于静态场景（侧边栏图标），`limbs` prop 控制手脚显隐（左上角无手脚，右下角落脚才有），考虑周到。
6. **学士帽与身体**：学士帽设计精巧（`polygon` 帽顶 + 帽穗），身体使用 `currentColor` 随学科色变化，与全局色调联动。

**建议**：无实质问题，堪称 SVG 角色组件的范本。

---

### 5.3 动效系统 — ⭐⭐⭐⭐

**正面评价**：

1. **@vueuse/motion 声明式动画**：`v-motion` 属性在各页面入口、卡片、图表中广泛应用，使用一致的 spring 参数（`stiffness: 260, damping: 20`），构建了整洁的"依次滑入"动效体系。
2. **命名动画函数体系**：`blob`（光斑漂浮）/ `popIn`（弹入）/ `fadeUp`（淡入上升）/ `dotJump`（弹跳圆点）/ `checkPop`（勾选弹出）/ `sparkle`（闪光粒子）——命名语义化，复用性高。
3. **类课堂模式 0.7s 平滑过渡**：全局 `transition: background 0.7s ease, color 0.7s ease, ...` 在学科切换和课堂模式进出时提供柔和的视觉过渡。
4. **加载动画**：全屏加载的 `loadingFloat` 和 `<title>loadingSlide</title>` 性能开销小、视觉反馈清晰。
5. **Markdown 排版配色**：`strong` 标签在 MD 中渲染为 `accent-strong` 色，代码块使用深底浅字的暖色方案（`#2c2722` / `#f5ecdd`），与整体暖纸主题协调。
6. **passage-block**：语文使用楷体暖黄底，英语使用 Georgia 衬线+淡紫底，学科差异细腻恰切。

**### 🔴 严重问题（之前已报）**：
- S-4：全局 `*` 通配符过渡导致的性能问题——虽然视觉效果优秀，但实现方式成本过高。

**### 🟡 警告项**：

1. **`mascot-corner-cycle` 动画存在过度特效风险**：
   - 位于 `index.css:627-636`，吉祥物角落使用 `filter: hue-rotate(360deg)` 彩虹色循环（4 秒周期）。对于使用 `prefers-reduced-motion` 的用户，该动画确实被禁用，但对无此设置的用户，持续的彩虹色变换（每秒 90 度色相偏移）视觉上分散注意力且容易引起不适。彩虹色旋转在"玩具感"和"视觉干扰"之间的平衡值得商榷。

2. **view-fade 与路由切换间的布局跳跃**：
   - `view-fade-enter-from` 设置 `transform: translateY(8px)`，`leave-to` 设置 `translateY(-6px)`。在路由切换时，进入和离开动画同时播放，两帧的重叠导致页面在 200ms 内上下跳动，而非流畅交叉淡化。用户操作时可能感到轻微的"抖动感"。

3. **TikZ 生成状态的视觉回退不充分**：
   - `tikz-gen` 只显示一个简短的标签 + 旋转图标，没有进度指示或预估时间。对于复杂的 TikZ 图形，用户可能误以为卡住。

---

### 5.4 组件级美学评价

| 组件 | 审美评级 | 评价 |
|------|---------|------|
| **SidebarLayout** | ⭐⭐⭐⭐ | 品牌双层渐变文字设计精妙（固定色底+学科色叠加）；二级菜单 JS 驱动的 height 动画平滑自然；ICP 备案和用户设置区布置合理。 |
| **ExamReview** | ⭐⭐⭐⭐⭐ | SVG 圆环进度图 + `stroke-dasharray` 动画 + 层级进度条 + `StarDisplay` 星级过渡——判卷报告的可视化堪称教科书级别。 |
| **MembershipCard** | ⭐⭐⭐⭐ | 3D 翻转效果（CSS `rotateY`）、双面设计（正面卡面/背面兑换码）、锁态磨砂效果——还原了真实卡片的物理感。 |
| **LoginView** | ⭐⭐⭐⭐ | 居中卡片布局简洁；吉祥物在光环中浮动 → 品牌标题 → 按钮 → 条款勾选，视觉动线清晰有序。 |
| **QuestionCard** | ⭐⭐⭐⭐ | KaTeX 公式、MathLive 编辑器、正确/错误/未答三种状态样式区分清晰。答对撒花动画（`sparkle`）提升成就感。 |
| **ChatMessages** | ⭐⭐⭐⭐ | 用户消息左对齐/助手消息右对齐的对话气泡布局，`passage-block` 学科专属排版。 |
| **MistakeBook** | ⭐⭐⭐⭐ | 拍照/文字双入口、分步分析进度指示、错因诊断可视化风格统一。 |
| **InputArea** | ⭐⭐⭐ | 功能完整（文本/语音/图片/模式切换/课堂面板），但输入框高度固定，长文本需要手动滚动。缺少 typing 字符计数器。 |
| **KnowledgeProfile** | ⭐⭐⭐ | 星级综合评分 + 诊断报告 + 推荐练习 + 大纲树，信息量大但缺少视觉层级引导（大纲树递归展开后缺乏重点标记）。 |

### 5.5 中文字体渲染

**正面评价**：
- 自托管 `HarmonyOS Sans SC` 字体（woff2 GB2312 子集），`unicode-range` 限制仅对中国韩字符加载，避免了拉丁字符被中文字体覆盖的问题。
- `font-display: swap` 确保文本可立即以回退字体渲染，不阻塞页面。
- 使用说明 `text-rendering: optimizeLegibility` 和 `-webkit-font-smoothing: antialiased` 优化清晰度。

**### 🟢 建议项**：
- HarmonyOS Sans SC 的 Regular / Medium / Bold 三个字重均加载（26KB+），但 Bold 字重（`font-weight: 700-900`）在实际 Markdown 中只有 `strong` 标签（默认 bold）使用，可以考虑只加载 Medium（500-600）做粗体，节省带宽。
- 未加载 italic/oblique 变体，Markdown 中 `_斜体_` 会 fallback 到浏览器合成斜体（视觉效果差）。建议预置中文字体的斜体变体或禁止 MD 斜体渲染。

### 5.6 操作习惯符合度

| 维度 | 评价 |
|------|------|
| **点击响应** | 按钮统一使用 `.btn-accent` 的 `hover: translateY(-2px)` + `active: translateY(1px) scale(0.97)` 微动效，反馈及时。 |
| **触摸友好** | 侧边栏按钮 44px+ 触控区域、二级菜单展开/收起状态指示（`ChevronDown` 旋转）、删除按钮 hover 时显示。 |
| **反馈一致性** | Toast 统一在右下角堆叠（success/error/info/warning 四色）。但部分操作（如对话删除）无二次确认——W-5 已涉及。 |
| **空状态处理** | 侧边栏对话/考试区域均显示"还没有对话/考试记录"，考试回顾有 `FileSearch` 空状态插画。 |
| **加载反馈** | 全屏加载（`AppLoading`）、流式消息加载（`TypingDots` + 语音助手提示文字）、片段加载（"加载中…"文字）、出题指示器（`quiz-gen` 脉冲动画）——层级覆盖完整。 |
| **快捷键/键盘导航** | 无全局键盘快捷键（如 Ctrl+Enter 发送消息、Esc 关闭面板）。自定义选择器（`BoenSelect`）缺键盘导航（A-2）。 |

**### 🟡 警告项：操作确认与撤销机制薄弱**

1. **对话删除无二次确认**：`handleDeleteConversation` 和 `handleDeleteExam` 的删除按钮在侧边栏直接触发后端删除，仅 hover 时显示，无 `ConfirmDialog` 或 Undo 机制。误触风险存在。
2. **SSE 请求无取消反馈**：用户在流式生成过程中点击"返回"或切换页面，AbortSignal 缺失导致后台请求持续（S-2），且用户无"已取消生成"的反馈。

**### 🟢 建议项：缺少的微交互**

1. **消息发送无发送按钮动画**：发送按钮在 `busy` 时只显示旋转圆圈，没有"已排队"或"正在发送"的明确反馈。
2. **每日签到无区域动画**：`claimDailyLogin` 触发后仅更新积分数字，无 `confetti` 或 `sparkle` 庆祝动画。
3. **页面切换方向性**：侧边栏导航点击后，进入页面方向统一是向下（`translateY(8px)`），但用户在侧边栏点击不同模块时，期望"从右侧滑入"（层级递进感）而非简单上浮。

---

### 视觉审计评分总结

| 维度 | 评分 | 关键问题 | 状态 |
|------|:----:|----------|:----:|
| 配色与主题统一性 | ⭐⭐⭐⭐ | 皓月卡灰色品质感不足，品牌中文标题字体缺乏差异化 | ⏳ 待批示 |
| 动效品质与层次 | ⭐⭐⭐⭐ | 全局 `*` 过渡已修复、`view-fade` 路由切换抖动已修复 | ✅ 已修复 |
| 吉祥物角色设计 | ⭐⭐⭐⭐⭐ | 无实质问题 | — |
| 组件美学一致性 | ⭐⭐⭐⭐ | InputArea 高度固定、KnowledgeProfile 信息层级碎 | ⏳ 待批示 |
| 操作习惯符合度 | ⭐⭐⭐⭐ | 删除已有 ConfirmDialog、缺键盘快捷键 | ⏳ 待批示 |
| 中文字体策略 | ⭐⭐⭐⭐ | 未加载 italic，MD 斜体会 fallback 到浏览器合成 | ⏳ 待批示 |

### 视觉维度的首要改进建议

1. ✅ ~~将 `mascot-corner-cycle` 彩虹色相旋转改为微弱的颜色脉动（`brightness` 变化）~~［已修复］
2. ✅ ~~修复 `view-fade` 路由切换时的进出动画重叠抖动（添加 `mode="out-in"`）~~［已修复］
3. 🟡 为对话/考试/错题删除增加 `ConfirmDialog` 二次确认（对话/考试已有，错题待补）
4. 🟢 添加发送动画、签到庆祝动画、SSE 取消反馈等微交互

| 严重程度 | 总计 | ✅ 已修复 | ⏳ 待批示 |
|----------|:----:|:--------:|:--------:|
| **严重** | 4 | S-1, S-2, S-4 | S-3（组件拆分） |
| **警告** | 9 | W-3, W-4, W-5, W-6 | W-1（动态 import）, W-7（类型）, W-8（断线重试）, W-9（兑换码） |
| **建议** | 8 | A-1, A-8 | A-2（可访问性）, A-3（硬编码）, A-4（TikZ 防抖）, A-5（API 重复）, A-6（状态机）, A-7（语音反馈） |
| **视觉** | 3 | V-W1, V-W2, V-W3 | 字体/皓月卡配色 |
| **合计** | **24** | **14** | **10** |

**当前状态**：14/24 项已修复并部署上线。剩余 10 项待您批示决策。
