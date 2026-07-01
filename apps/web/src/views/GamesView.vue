<script setup lang="ts">
import { ref } from 'vue';
import GameCanvas from '@/components/game/GameCanvas.vue';

const gameRef = ref<InstanceType<typeof GameCanvas>>();
const score = ref(0);
const showIntro = ref(true);

function onGameOver(finalScore: number): void {
  score.value = finalScore;
}

function startGame(): void {
  showIntro.value = false;
}

function restartGame(): void {
  gameRef.value?.restart();
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 顶部标题 -->
    <div class="flex items-center justify-between border-b border-slate-700/50 px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="text-xl">🏃</span>
        <h1 class="text-lg font-bold text-slate-100">知识跑酷</h1>
      </div>
      <div class="flex items-center gap-3 text-sm text-slate-400">
        <button
          class="rounded-lg bg-slate-800 px-3 py-1.5 transition hover:bg-slate-700"
          @click="restartGame"
        >
          🔄 重开
        </button>
      </div>
    </div>

    <!-- 游戏内容 -->
    <div class="flex-1 overflow-hidden">
      <!-- 开始界面 -->
      <div v-if="showIntro" class="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
        <div class="text-7xl">🏃‍♂️</div>
        <h2 class="text-2xl font-bold text-slate-100">知识跑酷</h2>
        <p class="max-w-xs text-slate-400">
          在跑道上奔跑，选择正确答案穿过拦截门！
          答对加速，答错扣命！
        </p>
        <div class="rounded-xl bg-slate-800/80 p-4 text-left text-sm text-slate-400">
          <p class="mb-2 font-semibold text-slate-300">🎮 操作说明</p>
          <p>← A / → D 切换跑道</p>
          <p>✅ 穿过正确选项的门 → 得分 + 加速</p>
          <p>❌ 撞上错误选项 → 扣一条命</p>
          <p class="mt-2 text-indigo-400">❤️ 共 3 条命，加油！</p>
        </div>
        <button
          class="rounded-xl bg-indigo-600 px-10 py-3 text-lg font-semibold text-white shadow-lg transition hover:bg-indigo-500 active:scale-95"
          @click="startGame"
        >
          🚀 开始挑战
        </button>
      </div>

      <!-- 游戏画布 -->
      <GameCanvas
        v-else
        ref="gameRef"
        @game-over="onGameOver"
      />
    </div>
  </div>
</template>
