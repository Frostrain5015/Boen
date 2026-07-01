<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import Phaser from 'phaser';
import { RunnerScene, type GameQuestion, type Subject } from '@/game/RunnerScene';

const props = defineProps<{ subject: Subject }>();
const emit = defineEmits<{ gameOver: [finalScore: number] }>();

const canvasContainer = ref<HTMLDivElement>();
let game: Phaser.Game | null = null;
let scene: RunnerScene | null = null;

const currentQuestion = ref<GameQuestion | null>(null);
const score = ref(0);
const lives = ref(3);
const isRunning = ref(false);
const questionVisible = ref(false);

onMounted(() => {
  if (!canvasContainer.value) return;

  game = new Phaser.Game({
    type: Phaser.AUTO,
    width: 480,
    height: 720,
    parent: canvasContainer.value,
    backgroundColor: '#1e1b2e',
    scene: [RunnerScene],
    physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  });

  game.events.on('ready', () => {
    scene = game!.scene.getScene('RunnerScene') as RunnerScene;
    scene.setSubject(props.subject);
    scene.setEvents({
      onScoreChange: (s) => { score.value = s; },
      onLivesChange: (l) => { lives.value = l; },
      onGameOver: (s) => { isRunning.value = false; emit('gameOver', s); },
      onQuestionChange: (q) => { currentQuestion.value = q; questionVisible.value = q !== null; },
    });
    isRunning.value = true;
  });
});

watch(() => props.subject, (sub) => {
  if (scene) scene.setSubject(sub);
});

onUnmounted(() => {
  if (game) { game.destroy(true); game = null; }
});
</script>

<template>
  <div class="game-wrapper relative mx-auto flex h-full w-full max-w-[480px] flex-col overflow-hidden bg-[#1e1b2e]">
    <!-- 顶部 HUD 覆盖层（匹配项目黏土质感） -->
    <div class="pointer-events-none absolute left-0 right-0 top-0 z-10 flex items-center justify-between px-3 pt-2">
      <div class="clay-sm flex items-center gap-1.5 bg-white/70 px-3 py-1">
        <span class="text-xs font-bold text-[var(--ink)]" style="font-family: var(--font-display)">🏆</span>
        <span class="text-sm font-bold text-[var(--accent-strong)]" style="font-family: var(--font-display)">{{ score }}</span>
      </div>
      <div class="clay-sm bg-white/70 px-3 py-1">
        <span class="text-sm">{{ '❤️'.repeat(Math.max(0, lives)) }}{{ '🖤'.repeat(Math.max(0, 3 - lives)) }}</span>
      </div>
    </div>

    <!-- 题目面板 -->
    <Transition name="panel-slide">
      <div
        v-if="questionVisible && currentQuestion"
        class="absolute left-3 right-3 top-[52px] z-10 rounded-xl border bg-[#1e293b]/95 px-3 py-2.5 text-center text-sm leading-snug text-slate-100 shadow-lg backdrop-blur"
        :style="{ borderColor: subject === 'math' ? '#14b48a' : subject === 'chinese' ? '#ff7a4d' : subject === 'english' ? '#6c5ce7' : '#3498db' }"
      >
        {{ currentQuestion.stem }}
      </div>
    </Transition>

    <!-- 键盘提示 -->
    <div class="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-slate-800/70 px-3 py-1 text-[10px] text-slate-400 backdrop-blur">
      ← A / D →
    </div>

    <!-- Phaser 画布 -->
    <div ref="canvasContainer" class="h-full w-full" />

    <!-- 游戏结束弹窗 -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="!isRunning && score > 0"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          @click.self="/* noop */"
        >
          <div class="clay mx-4 w-full max-w-xs bg-white/95 p-6 text-center">
            <div class="mb-1 text-4xl">🎮</div>
            <h2 class="mb-1 text-xl font-bold text-[var(--ink)]" style="font-family: var(--font-display)">游戏结束</h2>
            <p class="mb-4 text-3xl font-bold" :style="{ color: 'var(--accent-strong)' }" style="font-family: var(--font-display)">{{ score }} 分</p>
            <button class="btn-accent w-full rounded-[18px] px-6 py-3 text-base font-semibold text-white">
              🔄 再来一次
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.game-wrapper canvas { display: block; }
.panel-slide-enter-active, .panel-slide-leave-active { transition: all 0.3s ease; }
.panel-slide-enter-from, .panel-slide-leave-to { opacity: 0; transform: translateY(-16px); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
