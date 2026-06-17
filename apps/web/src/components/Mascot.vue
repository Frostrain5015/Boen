<script setup lang="ts">
export type MascotState = 'idle' | 'thinking' | 'listening' | 'quiz' | 'happy' | 'surprise' | 'sleepy';

interface Props {
  size?: number;
  float?: boolean;
  state?: MascotState;
  /** 是否显示手脚（仅右下角常驻吉祥物开启） */
  limbs?: boolean;
  /** 是否启用动画/表情；false 时为静态中性形象（左上角、回复前小图标） */
  animated?: boolean;
}

const { size = 64, float = true, state = 'idle', limbs = false, animated = true } = defineProps<Props>();
</script>

<template>
  <div
    class="mascot"
    :class="animated ? [float && 'floaty', `state-${state}`] : 'is-static'"
    :style="{ width: size + 'px', height: size + 'px', color: 'var(--accent)' }"
    aria-hidden="true"
  >
    <svg viewBox="0 0 100 104" :width="size" :height="size * 1.04" overflow="visible">
      <defs>
        <radialGradient id="bodyShine" cx="36%" cy="28%" r="78%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.6" />
          <stop offset="55%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="limbShade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000" stop-opacity="0.05" />
          <stop offset="100%" stop-color="#000" stop-opacity="0.2" />
        </linearGradient>
      </defs>

      <!-- 漂浮层：整体上下漂浮（与状态动作可叠加） -->
      <g class="gfloat">
        <!-- 脚（仅右下角常驻吉祥物显示） -->
        <g class="feet" v-if="limbs">
          <g class="foot foot-l">
            <ellipse cx="40" cy="92" rx="9" ry="5.5" fill="currentColor" />
            <ellipse cx="40" cy="92" rx="9" ry="5.5" fill="url(#limbShade)" />
          </g>
          <g class="foot foot-r">
            <ellipse cx="60" cy="92" rx="9" ry="5.5" fill="currentColor" />
            <ellipse cx="60" cy="92" rx="9" ry="5.5" fill="url(#limbShade)" />
          </g>
        </g>

        <!-- 手臂（仅右下角常驻吉祥物显示，让手掌从两侧探出） -->
        <g class="arm arm-l" v-if="limbs">
          <path d="M27 54 Q13 60 14 72" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" />
          <circle cx="14" cy="72" r="6.5" fill="currentColor" />
          <circle cx="14" cy="72" r="6.5" fill="url(#limbShade)" />
        </g>
        <g class="arm arm-r" v-if="limbs">
          <path d="M73 54 Q87 60 86 72" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" />
          <circle cx="86" cy="72" r="6.5" fill="currentColor" />
          <circle cx="86" cy="72" r="6.5" fill="url(#limbShade)" />
        </g>

        <!-- 身体 -->
        <circle cx="50" cy="55" r="33" fill="currentColor" />
        <path d="M20 64 A33 33 0 0 0 80 64 A40 40 0 0 1 20 64 Z" fill="#000" opacity="0.08" />
        <circle cx="50" cy="55" r="33" fill="url(#bodyShine)" />

        <!-- 腮红 -->
        <ellipse class="blush" cx="31" cy="62" rx="6" ry="4" fill="#ff8a6a" opacity="0.35" />
        <ellipse class="blush" cx="69" cy="62" rx="6" ry="4" fill="#ff8a6a" opacity="0.35" />

        <!-- 眉毛（思考/惊讶时可上挑） -->
        <g class="brows">
          <path class="brow brow-l" d="M34 41 Q40 38 46 41" stroke="#2c2722" stroke-width="2" stroke-linecap="round" fill="none" />
          <path class="brow brow-r" d="M54 41 Q60 38 66 41" stroke="#2c2722" stroke-width="2" stroke-linecap="round" fill="none" />
        </g>

        <!-- 眼睛（眼白固定，瞳孔可转动、整组可眨/睁大/眯） -->
        <g class="eyes">
          <ellipse cx="40" cy="51" rx="6.8" ry="7.8" fill="#fffdf9" />
          <ellipse cx="60" cy="51" rx="6.8" ry="7.8" fill="#fffdf9" />
          <g class="pupils">
            <circle cx="41.5" cy="52" r="3.5" fill="#2c2722" />
            <circle cx="61.5" cy="52" r="3.5" fill="#2c2722" />
            <circle cx="43" cy="50.2" r="1.2" fill="#fffdf9" />
            <circle cx="63" cy="50.2" r="1.2" fill="#fffdf9" />
          </g>
        </g>

        <!-- 嘴：三种形态按状态切换 -->
        <path class="mouth mouth-smile" d="M42 65 Q50 71 58 65" stroke="#2c2722" stroke-width="2.4" stroke-linecap="round" fill="none" />
        <path class="mouth mouth-grin" d="M41 64 Q50 76 59 64 Q50 69 41 64 Z" fill="#2c2722" />
        <ellipse class="mouth mouth-open" cx="50" cy="67" rx="5" ry="6" fill="#2c2722" />

        <!-- 学士帽 -->
        <g class="cap">
          <rect x="40" y="19" width="20" height="9" rx="2" fill="#2c2722" />
          <polygon points="50,11 76,21 50,31 24,21" fill="#37322c" />
          <polygon points="50,13 70,21 50,29 30,21" fill="#2c2722" />
          <circle cx="50" cy="21" r="2.4" fill="currentColor" />
        </g>

        <!-- 特效：思考点点 -->
        <g class="fx fx-think">
          <circle class="td td1" cx="80" cy="30" r="2.2" fill="currentColor" />
          <circle class="td td2" cx="87" cy="22" r="2.8" fill="currentColor" />
          <circle class="td td3" cx="94" cy="13" r="3.4" fill="currentColor" />
        </g>

        <!-- 特效：出题问号 -->
        <text class="fx fx-quiz" x="83" y="20" text-anchor="middle" fill="currentColor"
              font-size="20" font-weight="800" font-family="var(--font-display, sans-serif)">?</text>

        <!-- 特效：惊讶感叹号 -->
        <text class="fx fx-surprise" x="83" y="20" text-anchor="middle" fill="#ff7a4d"
              font-size="22" font-weight="900" font-family="var(--font-display, sans-serif)">!</text>

        <!-- 特效：开心星星 -->
        <g class="fx fx-happy">
          <path class="spark spark1" d="M18 24 L19.4 27.6 L23 29 L19.4 30.4 L18 34 L16.6 30.4 L13 29 L16.6 27.6 Z" fill="#ffd35c" />
          <path class="spark spark2" d="M84 30 L85 32.6 L87.6 33.6 L85 34.6 L84 37.2 L83 34.6 L80.4 33.6 L83 32.6 Z" fill="#ffd35c" />
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.mascot {
  display: inline-grid;
  place-items: center;
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}
svg { overflow: visible; }

g, .mouth, .pupils, .brow {
  transform-box: fill-box;
}

/* ── 持续小动作 ─────────────────────────────── */
.gfloat { transform-box: view-box; transform-origin: 50px 55px; }
.floaty .gfloat { animation: gfloat 4s ease-in-out infinite; }

.eyes { transform-origin: center; animation: blink 5.5s ease-in-out infinite; }
.pupils { transform-origin: center; transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1); }

.arm-l { transform-origin: 100% 0%; }
.arm-r { transform-origin: 0% 0%; }
.foot { transform-origin: center top; }
.mouth-grin, .mouth-open { display: none; }
.fx { opacity: 0; pointer-events: none; }

/* 静态形象：左上角与回复前小图标——冻结所有动画、固定中性表情 */
.is-static :where(.eyes, .gfloat, .pupils, .brow) { animation: none; transform: none; }
.is-static .fx { display: none; }

/* ── 整体状态动作（作用在根元素） ──────────────── */
.state-idle    { animation: breathe 3.4s ease-in-out infinite; }
.state-thinking{ animation: tiltThink 2.6s ease-in-out infinite; }
.state-listening{ animation: leanBob 1.6s ease-in-out infinite; }
.state-quiz    { animation: presentBob 2s ease-in-out infinite; }
.state-happy   { animation: cheerHop 0.62s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
.state-surprise{ animation: startle 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
.state-sleepy  { animation: sink 4.2s ease-in-out infinite; }

/* idle：手脚自然垂放，偶尔眨眼即可 */

/* thinking：右手托腮、左手背后、歪头、眼神上瞟、思考点点 */
.state-thinking .arm-r { animation: chinTap 2.6s ease-in-out infinite; }
.state-thinking .arm-l { transform: rotate(10deg); }
.state-thinking .pupils { transform: translate(-1.6px, -2.2px); }
.state-thinking .brow-l,
.state-thinking .brow-r { transform: translateY(-1.2px); }
.state-thinking .eyes { animation: blink 2.4s ease-in-out infinite; }
.state-thinking .fx-think { opacity: 1; }
.state-thinking .td { animation: thoughtPuff 1.8s ease-in-out infinite; }
.state-thinking .td2 { animation-delay: 0.25s; }
.state-thinking .td3 { animation-delay: 0.5s; }

/* listening：双臂轻摆、专注略睁眼 */
.state-listening .arm-l { animation: swayL 1.6s ease-in-out infinite; }
.state-listening .arm-r { animation: swayR 1.6s ease-in-out infinite; }
.state-listening .eyes { transform: scaleY(1.08); }

/* quiz（出题 / 等待作答）：右手举高呈现、问号弹跳、眼神看向题目 */
.state-quiz .arm-r { animation: raisePresent 2s ease-in-out infinite; }
.state-quiz .arm-l { transform: rotate(8deg); }
.state-quiz .pupils { transform: translate(0, 1.6px); }
.state-quiz .fx-quiz { opacity: 1; animation: fxBob 1.4s ease-in-out infinite; }

/* happy：双手欢呼、眯眼、咧嘴、星星闪 */
.state-happy .arm-l { animation: cheerL 0.62s ease-in-out infinite; }
.state-happy .arm-r { animation: cheerR 0.62s ease-in-out infinite; }
.state-happy .eyes { animation: squint 0.62s ease-in-out infinite; }
.state-happy .mouth-smile { display: none; }
.state-happy .mouth-grin { display: block; }
.state-happy .fx-happy { opacity: 1; }
.state-happy .spark { animation: twinkle 0.9s ease-in-out infinite; }
.state-happy .spark2 { animation-delay: 0.35s; }

/* surprise：瞪眼、张嘴、双手外张、感叹号 */
.state-surprise .arm-l { animation: flailL 0.5s ease-out; }
.state-surprise .arm-r { animation: flailR 0.5s ease-out; }
.state-surprise .eyes { transform: scale(1.18); }
.state-surprise .brow-l,
.state-surprise .brow-r { transform: translateY(-2px); }
.state-surprise .mouth-smile { display: none; }
.state-surprise .mouth-open { display: block; }
.state-surprise .fx-surprise { opacity: 1; animation: fxPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }

/* sleepy：缓缓下沉、久眨眼 */
.state-sleepy .eyes { animation: blink 7s ease-in-out infinite; }

/* ── 关键帧 ────────────────────────────────── */
@keyframes blink {
  0%, 92%, 100% { transform: scaleY(1); }
  96% { transform: scaleY(0.1); }
}
@keyframes squint {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(0.45); }
}
@keyframes gfloat {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}
@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.035); }
}
@keyframes tiltThink {
  0%, 100% { transform: rotate(-4deg); }
  50% { transform: rotate(2deg); }
}
@keyframes leanBob {
  0%, 100% { transform: translateY(0) rotate(-1deg); }
  50% { transform: translateY(-4px) rotate(1deg); }
}
@keyframes presentBob {
  0%, 100% { transform: translateY(0) rotate(2deg); }
  50% { transform: translateY(-3px) rotate(-1deg); }
}
@keyframes cheerHop {
  0%, 100% { transform: translateY(0) scale(1); }
  40% { transform: translateY(-9px) scale(1.05); }
  65% { transform: translateY(-1px) scale(0.98); }
}
@keyframes startle {
  0% { transform: scale(0.82) translateY(0); }
  45% { transform: scale(1.12) translateY(-4px); }
  100% { transform: scale(1) translateY(0); }
}
@keyframes sink {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(3px); }
}

/* 手臂 */
@keyframes chinTap {
  0%, 100% { transform: rotate(-46deg); }
  50% { transform: rotate(-50deg); }
}
@keyframes raisePresent {
  0%, 100% { transform: rotate(-58deg); }
  50% { transform: rotate(-66deg); }
}
@keyframes swayL {
  0%, 100% { transform: rotate(-6deg); }
  50% { transform: rotate(6deg); }
}
@keyframes swayR {
  0%, 100% { transform: rotate(6deg); }
  50% { transform: rotate(-6deg); }
}
@keyframes cheerL {
  0%, 100% { transform: rotate(-52deg); }
  50% { transform: rotate(-66deg); }
}
@keyframes cheerR {
  0%, 100% { transform: rotate(52deg); }
  50% { transform: rotate(66deg); }
}
@keyframes flailL {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(-26deg); }
}
@keyframes flailR {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(26deg); }
}

/* 特效 */
@keyframes thoughtPuff {
  0%, 100% { opacity: 0.25; transform: scale(0.7); }
  50% { opacity: 1; transform: scale(1); }
}
@keyframes twinkle {
  0%, 100% { opacity: 0.2; transform: scale(0.6) rotate(0deg); }
  50% { opacity: 1; transform: scale(1) rotate(45deg); }
}
@keyframes fxBob {
  0%, 100% { transform: translateY(0) rotate(-6deg); }
  50% { transform: translateY(-3px) rotate(6deg); }
}
@keyframes fxPop {
  0% { transform: scale(0) translateY(4px); }
  60% { transform: scale(1.25) translateY(-2px); }
  100% { transform: scale(1) translateY(0); }
}
.spark { transform-origin: center; }
.td { transform-origin: center; }
</style>
