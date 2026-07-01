<script setup lang="ts">
import { ref, shallowRef } from 'vue';
import GameCanvas from '@/components/game/GameCanvas.vue';
import type { Subject } from '@/game/RunnerScene';

const gameRef = ref<InstanceType<typeof GameCanvas>>();
const selectedSubject = ref<Subject | null>(null);
const playing = ref(false);
const finalScore = ref(0);

const subjects: { value: Subject; label: string; emoji: string; desc: string }[] = [
  { value: 'math', label: '数学', emoji: '🔢', desc: '数与运算、几何、逻辑' },
  { value: 'chinese', label: '语文', emoji: '📖', desc: '古诗、阅读理解、字词' },
  { value: 'english', label: '英语', emoji: '🔤', desc: '词汇、语法、日常对话' },
  { value: 'science', label: '科学', emoji: '🔬', desc: '物理、生物、天文常识' },
];

function start(subject: Subject): void {
  selectedSubject.value = subject;
  playing.value = true;
}

function onGameOver(score: number): void {
  finalScore.value = score;
}

function backToMenu(): void {
  playing.value = false;
  selectedSubject.value = null;
  finalScore.value = 0;
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 顶部栏 -->
    <div class="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="text-xl">🏃</span>
        <h1 class="text-lg font-bold" style="font-family: var(--font-display)">知识跑酷</h1>
      </div>
      <button
        v-if="playing"
        class="clay-sm flex items-center gap-1.5 bg-white/60 px-3 py-1.5 text-xs font-semibold text-[var(--ink-soft)] transition-colors hover:bg-white/90"
        @click="backToMenu"
      >
        ← 返回
      </button>
    </div>

    <div class="flex-1 overflow-hidden">
      <!-- ═══ 科目选择 ═══ -->
      <div v-if="!playing" class="flex h-full flex-col items-center justify-center gap-6 px-4 py-6">
        <div class="text-center">
          <div class="mb-2 text-5xl">🏃‍♂️</div>
          <h2 class="mb-1 text-xl font-bold text-[var(--ink)]" style="font-family: var(--font-display)">选择科目</h2>
          <p class="text-sm text-[var(--ink-soft)]">选一个科目开始跑酷答题</p>
        </div>

        <div class="grid w-full max-w-sm grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            v-for="sub in subjects"
            :key="sub.value"
            class="clay group flex flex-col items-center gap-2 bg-white/70 px-4 py-5 text-center transition-all duration-300 hover:-translate-y-1 hover:bg-white"
            :style="{
              '--accent': sub.value === 'math' ? '#14b48a' : sub.value === 'chinese' ? '#ff7a4d' : sub.value === 'english' ? '#6c5ce7' : '#3498db',
              '--accent-soft': sub.value === 'math' ? '#d9f4ec' : sub.value === 'chinese' ? '#ffe5d7' : sub.value === 'english' ? '#e8e4ff' : '#d4e6f1',
              '--accent-strong': sub.value === 'math' ? '#0e9b76' : sub.value === 'chinese' ? '#e06530' : sub.value === 'english' ? '#5a4bd1' : '#2c7bc7',
            }"
            @click="start(sub.value)"
          >
            <span class="text-3xl transition-transform duration-300 group-hover:scale-110">{{ sub.emoji }}</span>
            <span class="text-base font-bold" style="font-family: var(--font-display); color: var(--accent-strong)">{{ sub.label }}</span>
            <span class="text-xs text-[var(--ink-soft)]">{{ sub.desc }}</span>
            <!-- 底部强调线 -->
            <div
              class="mt-1 h-1 w-12 rounded-full transition-all duration-300 group-hover:w-20"
              :style="{ background: 'var(--accent)' }"
            />
          </button>
        </div>

        <div class="clay-sm max-w-xs bg-white/60 px-4 py-3 text-center">
          <p class="text-xs leading-relaxed text-[var(--ink-soft)]">
            🎮 <strong>A/D</strong> 或 <strong>←/→</strong> 切换跑道<br>
            选对穿门加分，选错扣命<br>
            共 ❤️❤️❤️ 3 条命，冲！
          </p>
        </div>
      </div>

      <!-- ═══ 游戏画布 ═══ -->
      <GameCanvas
        v-else
        ref="gameRef"
        :subject="selectedSubject!"
        @game-over="onGameOver"
      />
    </div>
  </div>
</template>
