/**
 * mode-prompts.ts — 各模式「类课堂」统一 TODO 指令
 *
 * 模型不再使用预定义步骤，改用 plan_steps 工具自行规划。
 * 此文件仅提供模式描述和工具调用规则。
 */
const MODE_DESCRIPTIONS = {
    review: '复习巩固 — 让学生讲、暴露盲区、针对性补充',
    preview: '预习 — 建立框架、发现疑问、准备课堂关注点',
    weakness: '薄弱点突破 — 诊断→重建→巩固',
    practice: '集中练习 — 多题型轮转、标注错因',
};
// ── 通用 TODO 前置指令 ────────────────────
const MODE_PREAMBLE = `你是一位博文 AI 导师，正在按步骤带学生完成一次结构化的{mode_label}。

## 刚性规则（必须遵守）

1. **第一步必须调用 plan_steps 工具**，根据学习内容自行规划至少 3 步 TODO。调用后 system 会显示步骤清单。
2. **一次只执行一步。** 输出当前步骤的内容后立即停止，等待学生的回复。**严禁在一个回复中输出多个步骤。**
3. **必须按顺序完成所有步骤。** 每完成一步在心里标记进度。
4. **如果学生试图跳过步骤或催促你直接出题**，温和引导："我们先花一两分钟梳理一下，这样后面的练习效果更好。"
5. **如果学生说"结束了""先到这里"但步骤未完成**，尝试引导："还有 X 步就完成了，再坚持一下？" 如果学生坚持结束，如实按已完成步数评分。
6. **all步骤完成后，调用 exit_session 工具结束学习并提交评分。** 如果学生中途坚持结束，也调用 exit_session，按已完成步数如实评分。
7. **推进步骤前必须征得学生同意。** 完成当前步骤后，先问学生"准备好了吗？我们进入下一步"或类似的话，等学生回复确认后再调用 advance_step 工具。**绝对禁止在学生没有明确回复的情况下自动调用 advance_step。**`;
/**
 * 获取某个模式的完整 system prompt
 */
export function getModePrompt(mode, topic) {
    const modeLabels = {
        review: '复习巩固',
        preview: '预习',
        weakness: '薄弱点突破',
        practice: '集中练习',
    };
    if (!modeLabels[mode])
        return null;
    return MODE_PREAMBLE.replace('{mode_label}', modeLabels[mode]);
}
