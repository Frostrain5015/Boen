---
name: quiz-generating-indicator
description: 正在出题指示器——检测用户消息含出题意图时，显示「博文正在出题」动画提示
metadata:
  type: reference
---

在 App.vue 中通过 `isGeneratingQuiz` computed 检测最后一个用户消息是否匹配出题/练习/阅读理解等关键词。匹配时，在 assistant 消息区显示 `quiz-gen` 指示器（黏土风格小卡片 + 旋转笔形图标 + 弹跳小圆点），替代原本的通用 TypingDots。CSS 集中在 index.css 的 `.quiz-gen` 块。

**Why:** 用户看到出题专用提示而非通用加载动画，不会误以为模型卡住。

**How:** `QUIZ_INTENT_RE` 正则 / 考我|考考|出一?[道题]|来一?[道题]|测验|测试|测一测|练习|出题|quiz|阅读|理解/ 匹配用户消息；`busy && assistant 无文本` 时触发。
