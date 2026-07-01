<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import Phaser from 'phaser';
import { RunnerScene, type GameQuestion } from '@/game/RunnerScene';

const emit = defineEmits<{
  scoreChange: [score: number];
  gameOver: [finalScore: number];
  livesChange: [lives: number];
}>();

const canvasContainer = ref<HTMLDivElement>();
let game: Phaser.Game | null = null;
let scene: RunnerScene | null = null;

const currentQuestion = ref<GameQuestion | null>(null);
const score = ref(0);
const lives = ref(3);
const isRunning = ref(false);
const questionPanelVisible = ref(false);

onMounted(() => {
  if (!canvasContainer.value) return;

  game = new Phaser.Game({
    type: Phaser.AUTO,
    width: 480,
    height: 720,
    parent: canvasContainer.value,
    backgroundColor: '#0f172a',
    scene: [RunnerScene],
    physics: {
      default: 'arcade',
      arcade: { gravity: { x: 0, y: 0 }, debug: false },
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  });

  game.events.on('ready', () => {
    scene = game!.scene.getScene('RunnerScene') as RunnerScene;
    scene.setEvents({
      onScoreChange: (s) => { score.value = s; },
      onLivesChange: (l) => { lives.value = l; },
      onGameOver: (s) => {
        isRunning.value = false;
        emit('gameOver', s);
      },
      onQuestionChange: (q) => {
        currentQuestion.value = q;
        questionPanelVisible.value = q !== null;
      },
    });
    isRunning.value = true;
  });
});

onUnmounted(() => {
  if (game) {
    game.destroy(true);
    game = null;
  }
});

function restart(): void {
  if (scene) {
    (scene as any).restartGame();
    isRunning.value = true;
    score.value = 0;
    lives.value = 3;
  }
}

defineExpose({ restart });
</script>

<template>
  <div class="game-wrapper relative mx-auto h-full w-full max-w-[480px] overflow-hidden rounded-xl border border-slate-700/50 bg-slate-900">
    <!-- 提示按键 -->
    <div v-if="isRunning" class="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full bg-slate-800/80 px-4 py-1.5 text-xs text-slate-400 backdrop-blur">
      ← A / D →  切换跑道
    </div>

    <!-- 题目面板（覆盖在游戏顶部） -->
    <Transition name="slide-down">
      <div
        v-if="questionPanelVisible && currentQuestion"
        class="absolute left-0 right-0 top-0 z-10 mx-4 mt-2 rounded-lg border border-indigo-500/50 bg-slate-800/95 p-3 text-center text-sm leading-snug text-slate-100 shadow-lg backdrop-blur"
      >
        📝 {{ currentQuestion.stem }}
      </div>
    </Transition>

    <!-- 游戏画布 -->
    <div ref="canvasContainer" class="h-full w-full" />

    <!-- 游戏结束覆盖层 -->
    <Teleport to="body">
      <div
        v-if="!isRunning && score > 0"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        @click.self="restart"
      >
        <div class="mx-4 w-full max-w-sm rounded-2xl border border-indigo-500/40 bg-slate-900 p-8 text-center shadow-2xl">
          <div class="mb-2 text-5xl">🎮</div>
          <h2 class="mb-1 text-2xl font-bold text-slate-100">游戏结束</h2>
          <p class="mb-6 text-4xl font-bold text-indigo-400">{{ score }} 分</p>
          <button
            class="rounded-xl bg-indigo-600 px-8 py-3 text-lg font-semibold text-white shadow transition hover:bg-indigo-500 active:scale-95"
            @click="restart"
          >
            🔄 再来一次
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.game-wrapper canvas {
  display: block;
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(-20px);
}
</style>
