<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

export type MascotState = 'idle' | 'thinking' | 'listening' | 'quiz' | 'happy' | 'surprise' | 'sleepy';

interface Props {
  size?: number;
  float?: boolean;
  state?: MascotState;
  /** 显示四肢（对话模式） */
  limbs?: boolean;
  /** 是否启用动画 */
  animated?: boolean;
}

const { size = 64, float = true, state = 'idle', limbs = false, animated = true } = defineProps<Props>();

const mascotRef = ref<HTMLElement | null>(null);
const mx = ref(0);
const my = ref(0);

function onMouse(e: MouseEvent) {
  if (!animated || !mascotRef.value) return;
  const r = mascotRef.value.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  mx.value = Math.max(-1, Math.min(1, (e.clientX - cx) / (r.width * 1.2)));
  my.value = Math.max(-1, Math.min(1, (e.clientY - cy) / (r.height * 1.4)));
}

onMounted(() => window.addEventListener('mousemove', onMouse, { passive: true }));
onUnmounted(() => window.removeEventListener('mousemove', onMouse));

const pupilShift = computed(() => {
  let ox = 0, oy = 0;
  if (state === 'thinking') { ox = -1.8; oy = -2.2; }
  else if (state === 'quiz')  { oy = 2.0; }
  const m = state === 'sleepy' ? 0.5 : 1;
  ox += mx.value * 2.2 * m;
  oy += my.value * 1.8 * m;
  return { transform: `translate(${ox}px, ${oy}px)` };
});
</script>

<template>
  <div
    ref="mascotRef"
    class="mascot"
    :class="animated ? [float && 'floaty', `state-${state}`, limbs && 'has-limbs'] : 'is-static'"
    :style="{ width: size + 'px', height: size + 'px', color: 'var(--accent, #f09070)' }"
    aria-hidden="true"
  >
    <svg viewBox="0 0 100 120" :width="size" :height="size * 1.2" overflow="visible">
      <defs>
        <!-- 身体高光（原始色彩逻辑：currentColor + 单层白高光） -->
        <radialGradient id="bodyShine" cx="35%" cy="30%" r="72%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55" />
          <stop offset="55%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>

        <!-- 底部阴影渐变（3D果冻深度） -->
        <radialGradient id="bodyShadow" cx="50%" cy="88%" r="50%" fx="50%" fy="78%">
          <stop offset="0%" stop-color="#000000" stop-opacity="0" />
          <stop offset="65%" stop-color="#000000" stop-opacity="0.04" />
          <stop offset="100%" stop-color="#000000" stop-opacity="0.2" />
        </radialGradient>

        <!-- 四肢渐变（从身体色延伸） -->
        <radialGradient id="limbShine" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.45" />
          <stop offset="60%" stop-color="#ffffff" stop-opacity="0" />
        </radialGradient>

        <!-- 眼白渐变（暖白→柔和阴影） -->
        <radialGradient id="eyeWhiteGrad" cx="50%" cy="35%" r="55%">
          <stop offset="0%" stop-color="#fffdf9" />
          <stop offset="55%" stop-color="#f8f3e8" />
          <stop offset="100%" stop-color="#e6dcd0" />
        </radialGradient>

        <!-- 瞳孔渐变：深色有光泽 -->
        <radialGradient id="pupilGrad" cx="40%" cy="35%" r="60%">
          <stop offset="0%" stop-color="#3a3530" />
          <stop offset="100%" stop-color="#0f0e0c" />
        </radialGradient>

        <!-- 口腔渐变 -->
        <radialGradient id="mouthGrad" cx="50%" cy="30%" r="60%">
          <stop offset="0%" stop-color="#6b5e55" />
          <stop offset="100%" stop-color="#2c2722" />
        </radialGradient>

        <!-- 学士帽 -->
        <linearGradient id="capGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3d372f" />
          <stop offset="100%" stop-color="#1c1815" />
        </linearGradient>

        <!-- 镜片裁剪 -->
        <clipPath id="lcL"><circle cx="36" cy="47" r="12.5" /></clipPath>
        <clipPath id="lcR"><circle cx="64" cy="47" r="12.5" /></clipPath>
      </defs>

      <!-- ══════ 主图层 ══════ -->
      <g class="gfloat">

        <!-- ━━━━ 四肢：椭圆/圆柱 Q版，紧贴身体，果冻质感 ━━━━ -->
        <g v-if="limbs" class="limbs-group">
          <!-- 左臂（圆柱形） + 左手（椭圆肉球） -->
          <g class="limb limb-l">
            <path d="M22 63 Q14 68 13 78" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" />
            <path d="M22 63 Q14 68 13 78" fill="none" stroke="url(#limbShine)" stroke-width="11" stroke-linecap="round" />
            <ellipse cx="12" cy="82" rx="7" ry="8" fill="currentColor" />
            <ellipse cx="12" cy="82" rx="7" ry="8" fill="url(#limbShine)" />
          </g>

          <!-- 右臂（圆柱形） + 右手（椭圆肉球） -->
          <g class="limb limb-r">
            <path d="M78 63 Q86 68 87 78" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" />
            <path d="M78 63 Q86 68 87 78" fill="none" stroke="url(#limbShine)" stroke-width="11" stroke-linecap="round" />
            <ellipse cx="88" cy="82" rx="7" ry="8" fill="currentColor" />
            <ellipse cx="88" cy="82" rx="7" ry="8" fill="url(#limbShine)" />
          </g>

          <!-- 左脚（椭圆肉球） -->
          <g class="limb foot-l">
            <ellipse cx="33" cy="99" rx="10" ry="6.5" fill="currentColor" />
            <ellipse cx="33" cy="99" rx="10" ry="6.5" fill="url(#limbShine)" />
          </g>

          <!-- 右脚（椭圆肉球） -->
          <g class="limb foot-r">
            <ellipse cx="67" cy="99" rx="10" ry="6.5" fill="currentColor" />
            <ellipse cx="67" cy="99" rx="10" ry="6.5" fill="url(#limbShine)" />
          </g>
        </g>

        <!-- ══════ 身体（currentColor + 阴影 + 高光 = 果冻质感） ══════ -->
        <g class="jelly-body">
          <circle cx="50" cy="56" r="34" fill="currentColor" />
          <circle cx="50" cy="56" r="34" fill="url(#bodyShadow)" />
          <circle cx="50" cy="56" r="34" fill="url(#bodyShine)" />
        </g>

        <!-- ══════ 腮红 ══════ -->
        <ellipse cx="30" cy="64" rx="6.5" ry="4.5" fill="#ffffff" opacity="0.4" />
        <ellipse cx="70" cy="64" rx="6.5" ry="4.5" fill="#ffffff" opacity="0.4" />

        <!-- ══════ 眼镜 ══════ -->
        <g class="glasses">
          <circle cx="36" cy="47" r="12.5" fill="none" stroke="#2c2722" stroke-width="2.2" />
          <circle cx="64" cy="47" r="12.5" fill="none" stroke="#2c2722" stroke-width="2.2" />
          <path d="M48.5 47 Q50 44.5 51.5 47" fill="none" stroke="#2c2722" stroke-width="2" stroke-linecap="round" />
          <line x1="23.5" y1="47" x2="17" y2="44" stroke="#2c2722" stroke-width="1.8" stroke-linecap="round" />
          <line x1="76.5" y1="47" x2="83" y2="44" stroke="#2c2722" stroke-width="1.8" stroke-linecap="round" />

          <!-- 左眼 -->
          <g clip-path="url(#lcL)">
            <g class="eye-inner" :class="`eye-${state}`">
              <!-- 眼白（渐变） -->
              <ellipse cx="36" cy="47" rx="6.5" ry="7.5" fill="url(#eyeWhiteGrad)" class="eye-bg" />
              <!-- 瞳孔（渐变质感） -->
              <circle class="pupil pupil-l eye-normal" cx="37" cy="47.5" r="4.8" fill="url(#pupilGrad)" :style="pupilShift" />
              <!-- happy 弯月眼 -->
              <path class="eye-happy" d="M29 46 Q36 38 43 46" fill="none" stroke="#2c2722" stroke-width="3" stroke-linecap="round" />
              <!-- surprise 圆眼 -->
              <circle cx="36" cy="47" r="8" fill="url(#eyeWhiteGrad)" class="eye-surprise" />
              <circle class="pupil pupil-l eye-surprise" cx="37" cy="46.5" r="5.5" fill="url(#pupilGrad)" />
              <!-- sleepy 半闭眼 -->
              <circle cx="36" cy="47" r="7.5" fill="url(#eyeWhiteGrad)" opacity="0.35" class="eye-sleepy" />
              <circle class="pupil pupil-l eye-sleepy" cx="37" cy="48" r="3.5" fill="url(#pupilGrad)" />
              <path class="eye-sleepy" d="M29 44 Q36 49 43 44" fill="currentColor" opacity="0.55" />
              <!-- 双层高光 -->
              <circle cx="39" cy="44" r="1.4" fill="#ffffff" opacity="0.95" class="eye-hl eye-normal" />
              <circle cx="34.5" cy="50.5" r="0.65" fill="#ffffff" opacity="0.45" class="eye-hl eye-normal" />
              <circle cx="39" cy="43" r="1.3" fill="#ffffff" opacity="0.9" class="eye-hl eye-surprise" />
              <circle cx="33.5" cy="49.5" r="0.55" fill="#ffffff" opacity="0.35" class="eye-hl eye-surprise" />
            </g>
            <!-- 镜片反光 -->
            <path d="M26 38 Q35 37 41 37" fill="none" stroke="#ffffff" stroke-width="1.5" opacity="0.3" stroke-linecap="round" />
          </g>

          <!-- 右眼 -->
          <g clip-path="url(#lcR)">
            <g class="eye-inner" :class="`eye-${state}`">
              <ellipse cx="64" cy="47" rx="6.5" ry="7.5" fill="url(#eyeWhiteGrad)" class="eye-bg" />
              <circle class="pupil pupil-r eye-normal" cx="65" cy="47.5" r="4.8" fill="url(#pupilGrad)" :style="pupilShift" />
              <path class="eye-happy" d="M57 46 Q64 38 71 46" fill="none" stroke="#2c2722" stroke-width="3" stroke-linecap="round" />
              <circle cx="64" cy="47" r="8" fill="url(#eyeWhiteGrad)" class="eye-surprise" />
              <circle class="pupil pupil-r eye-surprise" cx="65" cy="46.5" r="5.5" fill="url(#pupilGrad)" />
              <circle cx="64" cy="47" r="7.5" fill="url(#eyeWhiteGrad)" opacity="0.35" class="eye-sleepy" />
              <circle class="pupil pupil-r eye-sleepy" cx="65" cy="48" r="3.5" fill="url(#pupilGrad)" />
              <path class="eye-sleepy" d="M57 44 Q64 49 71 44" fill="currentColor" opacity="0.55" />
              <circle cx="67" cy="44" r="1.4" fill="#ffffff" opacity="0.95" class="eye-hl eye-normal" />
              <circle cx="62.5" cy="50.5" r="0.65" fill="#ffffff" opacity="0.45" class="eye-hl eye-normal" />
              <circle cx="67" cy="43" r="1.3" fill="#ffffff" opacity="0.9" class="eye-hl eye-surprise" />
              <circle cx="61.5" cy="49.5" r="0.55" fill="#ffffff" opacity="0.35" class="eye-hl eye-surprise" />
            </g>
            <path d="M54 37 Q64 38 70 38" fill="none" stroke="#ffffff" stroke-width="1.5" opacity="0.3" stroke-linecap="round" />
          </g>
        </g>

        <!-- ══════ 嘴巴（渐变质感） ══════ -->
        <g class="mouth-group">
          <!-- idle 微笑 -->
          <path class="mouth mouth-smile" d="M42 66 Q50 72 58 66" stroke="url(#mouthGrad)" stroke-width="2.6" stroke-linecap="round" fill="none" />
          <!-- thinking 歪嘴 -->
          <path class="mouth mouth-think" d="M40 66 Q47 70 53 68 Q57 69 60 65" stroke="url(#mouthGrad)" stroke-width="2.2" stroke-linecap="round" fill="none" />
          <!-- happy 咧嘴笑 -->
          <path class="mouth mouth-grin" d="M38 65 Q50 80 62 65" fill="url(#mouthGrad)" />
          <path class="mouth mouth-grin" d="M38 65 Q50 80 62 65" fill="none" stroke="#2c2722" stroke-width="1.5" />
          <!-- quiz O嘴 -->
          <ellipse class="mouth mouth-quiz" cx="50" cy="68" rx="5.5" ry="6" fill="url(#mouthGrad)" />
          <!-- surprise 大O嘴 -->
          <ellipse class="mouth mouth-open" cx="50" cy="68" rx="9.5" ry="11" fill="url(#mouthGrad)" />
          <!-- sleepy 小嘴 -->
          <ellipse class="mouth mouth-sleepy" cx="50" cy="69" rx="4" ry="4.5" fill="url(#mouthGrad)" opacity="0.7" />
        </g>

        <!-- ══════ 学士帽 ══════ -->
        <g class="cap">
          <rect x="40" y="20" width="20" height="9" rx="2" fill="url(#capGrad)" />
          <polygon points="50,12 76,22 50,32 24,22" fill="#37322c" />
          <polygon points="50,14 70,22 50,30 30,22" fill="#2c2722" />
          <!-- 流苏 -->
          <g class="tassel">
            <path d="M50 22 L70 22 L70 32" stroke="#2c2722" stroke-width="1.6" fill="none" />
            <circle cx="70" cy="33" r="2.6" fill="currentColor" />
            <g stroke="currentColor" stroke-width="0.6" fill="none">
              <line x1="70.2" y1="35" x2="70.2" y2="42" />
              <line x1="68.8" y1="35.2" x2="67.5" y2="42.5" />
              <line x1="71.5" y1="35.2" x2="72.8" y2="42.5" />
            </g>
          </g>
        </g>

        <!-- ══════ 特效 ══════ -->
        <g class="fx fx-think">
          <circle class="td td1" cx="84" cy="28" r="2.5" fill="#888" />
          <circle class="td td2" cx="92" cy="20" r="3.2" fill="#999" />
          <circle class="td td3" cx="99" cy="10" r="4" fill="#aaa" />
        </g>
        <text class="fx fx-quiz" x="88" y="20" text-anchor="middle" fill="#daa520"
              font-size="22" font-weight="800" font-family="var(--font-display, sans-serif)">?</text>
        <text class="fx fx-surprise" x="88" y="20" text-anchor="middle" fill="#e8a090"
              font-size="24" font-weight="900" font-family="var(--font-display, sans-serif)">!</text>
        <g class="fx fx-happy">
          <path class="spark spark1" d="M14 16 L15.5 20 L19.5 21.5 L15.5 23 L14 27 L12.5 23 L8.5 21.5 L12.5 20 Z" fill="#f5d060" />
          <path class="spark spark2" d="M88 22 L89 25 L92 26 L89 27 L88 30 L87 27 L84 26 L87 25 Z" fill="#f5d060" />
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

.jelly-body, .mouth, .pupil, .eye-inner, .glasses, .tassel, .limb, .foot-l { transform-box: fill-box; }

/* ── 果冻抖动 ──────────────────────── */
.jelly-body {
  transform-origin: 50px 56px;
  animation: jellyWobble 5s ease-in-out infinite;
}

/* ── 浮动 ─────────────────────────── */
.gfloat { transform-box: view-box; transform-origin: 50px 56px; }
.floaty .gfloat { animation: gfloat 4s ease-in-out infinite; }

.eye-inner {
  transform-origin: center;
  animation: blink 5.5s ease-in-out infinite;
}
.pupil { transition: transform 0.15s ease-out; }

/* ── 四肢 ── */
.limb-l { transform-origin: 22px 63px; }
.limb-r { transform-origin: 78px 63px; }
.foot-l { transform-origin: 33px 99px; }
.foot-r { transform-origin: 67px 99px; }

/* 弹簧弹入 */
.limbs-group { opacity: 0; visibility: hidden; }
.has-limbs .limbs-group { opacity: 1; visibility: visible; }

.has-limbs .limb-l {
  animation: limbSpringL 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
             limbFloatL 3s ease-in-out 0.5s infinite;
}
.has-limbs .limb-r {
  animation: limbSpringR 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
             limbFloatR 3s ease-in-out 0.5s infinite;
}
.has-limbs .foot-l {
  animation: footPop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
             footFloat 3.2s ease-in-out 0.45s infinite;
}
.has-limbs .foot-r {
  animation: footPop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) forwards 0.08s,
             footFloat 3.2s ease-in-out 0.53s infinite;
}


/* 各状态四肢动画 —— 所有表情一致，四肢不随表情变化 */

/* ── 默认显示规则 ───────────────────── */
.eye-happy, .eye-surprise, .eye-sleepy { display: none; }
.eye-hl.eye-surprise { display: none; }
.mouth-think, .mouth-grin, .mouth-quiz, .mouth-open, .mouth-sleepy { display: none; }
.fx { opacity: 0; pointer-events: none; }

/* ── thinking ── */
.state-thinking .mouth-smile { display: none; }
.state-thinking .mouth-think { display: block; }

/* ── happy ── */
.state-happy .eye-normal { display: none; }
.state-happy .eye-happy { display: block; }
.state-happy .eye-bg { display: none; }
.state-happy .eye-hl { display: none; }
.state-happy .mouth-smile { display: none; }
.state-happy .mouth-grin { display: block; }

/* ── surprise ── */
.state-surprise .eye-normal { display: none; }
.state-surprise .eye-surprise { display: block; }
.state-surprise .eye-hl.eye-normal { display: none; }
.state-surprise .eye-hl.eye-surprise { display: block; }
.state-surprise .mouth-smile { display: none; }
.state-surprise .mouth-open { display: block; }

/* ── quiz ── */
.state-quiz .mouth-smile { display: none; }
.state-quiz .mouth-quiz { display: block; }

/* ── sleepy ── */
.state-sleepy .eye-normal { display: none; }
.state-sleepy .eye-sleepy { display: block; }
.state-sleepy .eye-hl { display: none; }
.state-sleepy .mouth-smile { display: none; }
.state-sleepy .mouth-sleepy { display: block; }

/* ── 流苏 ── */
.tassel { transform-origin: 50px 22px; animation: tasselSway 3s ease-in-out infinite; }

/* ── 静态 ── */
.is-static .eye-inner,
.is-static .jelly-body,
.is-static :where(.gfloat, .pupil, .tassel) { animation: none; transform: none; }
.is-static .fx { display: none; }
.is-static .limbs-group { display: none; }

/* ── 状态根动画 ──────────────────────── */
.state-idle     { animation: breathe 3.4s ease-in-out infinite; }
.state-thinking { animation: tiltThink 2.6s ease-in-out infinite; }
.state-listening{ animation: leanBob 1.6s ease-in-out infinite; }
.state-quiz     { animation: presentBob 2s ease-in-out infinite; }
.state-happy    { animation: cheerHop 0.62s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
.state-surprise { animation: startle 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
.state-sleepy   { animation: sink 4.2s ease-in-out infinite; }

/* ── thinking 特效 ── */
.state-thinking .fx-think { opacity: 1; }
.state-thinking .td { animation: thoughtPuff 1.8s ease-in-out infinite; }
.state-thinking .td2 { animation-delay: 0.25s; }
.state-thinking .td3 { animation-delay: 0.5s; }
.state-thinking .eye-inner { animation: blink 2.4s ease-in-out infinite; }

/* ── quiz ── */
.state-quiz .fx-quiz { opacity: 1; animation: fxBob 1.4s ease-in-out infinite; }

/* ── happy ── */
.state-happy .fx-happy { opacity: 1; }
.state-happy .spark { animation: twinkle 0.9s ease-in-out infinite; }
.state-happy .spark2 { animation-delay: 0.35s; }

/* ── surprise ── */
.state-surprise .fx-surprise { opacity: 1; animation: fxPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }

/* ── sleepy ── */
.state-sleepy .eye-inner { animation: blink 7s ease-in-out infinite; }

/* ══════ 关键帧 ════════════════════════════ */

@keyframes jellyWobble {
  0%, 100% { transform: scaleX(1) scaleY(1); }
  14% { transform: scaleX(1.025) scaleY(0.975); }
  28% { transform: scaleX(0.98) scaleY(1.028); }
  42% { transform: scaleX(1.012) scaleY(0.99); }
  56% { transform: scaleX(1) scaleY(1); }
  68% { transform: scaleX(1.008) scaleY(0.994); }
  84% { transform: scaleX(1) scaleY(1); }
}

@keyframes limbSpringL {
  0%   { transform: scale(0.6); opacity: 0; }
  70%  { transform: scale(1.08); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes limbSpringR {
  0%   { transform: scale(0.6); opacity: 0; }
  70%  { transform: scale(1.08); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes footPop {
  0%   { transform: scale(0) translateY(4px); opacity: 0; }
  70%  { transform: scale(1.12) translateY(-1px); opacity: 1; }
  100% { transform: scale(1) translateY(0); opacity: 1; }
}

@keyframes limbFloatL {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}
@keyframes limbFloatR {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}
@keyframes footFloat {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-1.5px); }
}

@keyframes blink {
  0%, 86%, 100% { transform: scaleY(1); }
  92%, 97% { transform: scaleY(0.08); }
}
@keyframes gfloat {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}
@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.032); }
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
  0% { transform: scale(0.92) translateY(0); }
  45% { transform: scale(1.08) translateY(-4px); }
  100% { transform: scale(1) translateY(0); }
}
@keyframes sink {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(3px); }
}
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
@keyframes tasselSway {
  0%, 100% { transform: rotate(0deg); }
  33% { transform: rotate(4deg); }
  66% { transform: rotate(-3deg); }
}
.spark { transform-origin: center; }
.td { transform-origin: center; }
</style>
