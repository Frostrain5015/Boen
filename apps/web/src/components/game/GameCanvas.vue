<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import Phaser from 'phaser';
import { RunnerScene, type Subject, type GameQuestion } from '@/game/RunnerScene';

const props = defineProps<{ subject: Subject }>();

interface GameOverStats {
  score: number;
  totalQuestions: number;
  correctQuestions: number;
  accuracyRate: number;
}

const emit = defineEmits<{
  (e: 'gameOver', stats: GameOverStats): void;
}>();

const canvasContainer = ref<HTMLDivElement>();
let game: Phaser.Game | null = null;
let scene: RunnerScene | null = null;

const score = ref(0);
const lives = ref(3);
const isRunning = ref(false);
const isLoading = ref(true);          // 初始加载状态
const totalQuestions = ref(0);
const correctQuestions = ref(0);
const accuracyRate = ref(0);
const showGameOver = ref(false);
const currentQuestion = ref<GameQuestion | null>(null);

function restart() {
  if (!scene) return;
  scene.doRestart();
  isRunning.value = true;
  showGameOver.value = false;
  isLoading.value = false;
  score.value = 0;
  lives.value = 3;
  totalQuestions.value = 0;
  correctQuestions.value = 0;
  accuracyRate.value = 0;
  currentQuestion.value = null;
}

onMounted(() => {
  if (!canvasContainer.value) return;

  game = new Phaser.Game({
    type: Phaser.AUTO,
    width: 480,
    height: 720,
    parent: canvasContainer.value,
    backgroundColor: '#fbf6ee',
    scene: [RunnerScene],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  });

  game.events.on('ready', () => {
    scene = game!.scene.getScene('RunnerScene') as unknown as RunnerScene;
    scene.setSubject(props.subject);
    scene.setGameEvents({
      onScoreChange: (s) => { score.value = s; },
      onLivesChange: (l) => { lives.value = l; },
      onStatsChange: (stats) => {
        totalQuestions.value = stats.totalQuestions;
        correctQuestions.value = stats.correctQuestions;
        accuracyRate.value = stats.accuracyRate;
        // 一旦统计数据开始更新，隐藏加载状态
        if (isLoading.value) isLoading.value = false;
      },
      onQuestionChange: (q) => {
        currentQuestion.value = q;
        // 题目出现时隐藏加载状态
        if (q && isLoading.value) isLoading.value = false;
      },
      onGameOver: (stats) => {
        isRunning.value = false;
        showGameOver.value = true;
        isLoading.value = false;
        totalQuestions.value = stats.totalQuestions;
        correctQuestions.value = stats.correctQuestions;
        accuracyRate.value = stats.accuracyRate;
        emit('gameOver', stats);
      },
    });
    isRunning.value = true;
  });
});

watch(() => props.subject, (sub) => {
  if (scene) {
    isLoading.value = true;
    currentQuestion.value = null;
    scene.setSubject(sub);
    // 切换学科后重新获取题目
    scene.doRestart();
  }
});

onUnmounted(() => {
  if (game) { game.destroy(true); game = null; }
});
</script>

<template>
  <div class="game-wrapper relative h-full w-full overflow-hidden" style="background: var(--paper);">
    <!-- Phaser 画布（铺满容器） -->
    <div ref="canvasContainer" class="h-full w-full" />

    <!-- 加载遮罩 -->
    <Transition name="fade">
      <div
        v-if="isLoading && !showGameOver"
        class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[var(--paper)]/60 backdrop-blur-[2px]"
      >
        <div class="flex flex-col items-center gap-3">
          <div class="h-8 w-8 animate-spin rounded-full border-3 border-[var(--accent)] border-t-transparent" />
          <p class="text-sm font-medium" style="color: var(--ink-soft)">题目加载中…</p>
        </div>
      </div>
    </Transition>

    <!-- 顶部 HUD 覆盖层 -->
    <div class="pointer-events-none absolute left-0 right-0 top-0 z-10 flex items-center justify-between px-3 pt-2">
      <div class="clay-sm flex items-center gap-1.5 bg-white/80 px-3 py-1 shadow-sm">
        <span class="text-xs font-bold text-[var(--ink-soft)]">🏆</span>
        <span class="text-sm font-bold" style="font-family: var(--font-display); color: var(--accent-strong)">{{ score }}</span>
      </div>
      <div class="clay-sm bg-white/80 px-3 py-1 shadow-sm">
        <span class="text-sm">{{ '❤️'.repeat(Math.max(0, lives)) }}{{ '🖤'.repeat(Math.max(0, 3 - lives)) }}</span>
      </div>
    </div>

    <!-- 当前题目提示（底部） -->
    <Transition name="fade">
      <div
        v-if="currentQuestion"
        class="pointer-events-none absolute bottom-12 left-1/2 z-10 max-w-[90%] -translate-x-1/2 rounded-xl bg-white/85 px-4 py-2 text-center shadow-md backdrop-blur"
      >
        <p class="text-xs leading-snug font-medium" style="color: var(--ink)">{{ currentQuestion.stem }}</p>
      </div>
    </Transition>

    <!-- 键盘提示 -->
    <div class="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-white/70 px-3 py-1 text-[10px] shadow-sm backdrop-blur" style="color: var(--ink-soft)">
      ← A / D →
    </div>

    <!-- 游戏结束弹窗 -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="showGameOver"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        >
          <div class="clay mx-4 w-full max-w-xs bg-white p-6 text-center">
            <div class="mb-1 text-4xl">🎮</div>
            <h2 class="mb-1 text-xl font-bold text-[var(--ink)]" style="font-family: var(--font-display)">游戏结束</h2>
            <p class="mb-4 text-3xl font-bold" style="font-family: var(--font-display); color: var(--accent-strong)">{{ score }} 分</p>

            <div class="mb-4 grid grid-cols-3 gap-2 rounded-xl bg-[var(--accent-soft)]/50 p-3">
              <div class="text-center">
                <div class="text-xs text-[var(--ink-soft)]">总题数</div>
                <div class="text-lg font-bold text-[var(--accent-strong)]">{{ totalQuestions }}</div>
              </div>
              <div class="text-center">
                <div class="text-xs text-[var(--ink-soft)]">正确</div>
                <div class="text-lg font-bold text-[var(--accent-strong)]">{{ correctQuestions }}</div>
              </div>
              <div class="text-center">
                <div class="text-xs text-[var(--ink-soft)]">正确率</div>
                <div class="text-lg font-bold text-[var(--accent-strong)]">{{ accuracyRate }}%</div>
              </div>
            </div>

            <button
              class="btn-accent w-full rounded-[18px] px-6 py-3 text-base font-semibold text-white"
              @click="restart"
            >
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
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
@keyframes spin {
  to { transform: rotate(360deg); }
}
.animate-spin { animation: spin 0.8s linear infinite; }
</style>
