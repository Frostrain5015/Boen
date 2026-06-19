<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Grade } from '@boen/shared';
import { Sparkles, User, GraduationCap, ArrowLeft } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const GRADE_GROUPS: { band: string; items: { value: Grade; label: string }[] }[] = [
  { band: '小学', items: ['一', '二', '三', '四', '五', '六'].map((c, i) => ({ value: String(i + 1) as Grade, label: `${c}年级` })) },
  { band: '初中', items: ['一', '二', '三'].map((c, i) => ({ value: String(i + 7) as Grade, label: `初${c}` })) },
  { band: '其他', items: [{ value: 'high', label: '高中' }, { value: 'college', label: '大学及以上' }] },
];

const name = ref(authStore.userProfile?.name ?? '');
const grade = ref<Grade>(authStore.userProfile?.grade ?? '8');
const modelProvider = ref(localStorage.getItem('boen_model_provider') || 'default');

function handleSave() {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  localStorage.setItem('boen_model_provider', modelProvider.value);
  authStore.saveProfile({ name: trimmed, grade: grade.value });
  fetch('/api/model/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: modelProvider.value }),
  }).catch(() => {});
  router.push('/');
}
</script>

<template>
  <div class="flex min-h-full flex-col items-center justify-center p-6">
    <div class="w-full max-w-md">
      <!-- 头部 -->
      <div class="mb-6 flex items-center gap-3">
        <button @click="router.push('/')" class="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50">
          <ArrowLeft class="h-5 w-5" style="color: var(--ink-soft)" />
        </button>
        <div>
          <h1 class="font-display text-lg font-bold" style="color: var(--ink)">设置</h1>
          <p class="text-sm" style="color: var(--ink-soft)">个性化你的学习体验</p>
        </div>
      </div>

      <!-- 表单卡片 -->
      <div class="clay clay-glass overflow-hidden">
        <div class="flex flex-col items-center gap-3 px-6 pt-8 pb-4 text-center">
          <div class="grid h-14 w-14 place-items-center rounded-full" style="background: var(--accent-soft); color: var(--accent-strong)">
            <Sparkles class="h-7 w-7" />
          </div>
          <h2 class="font-display text-xl font-bold" style="color: var(--ink)">欢迎来到博文</h2>
          <p class="text-sm" style="color: var(--ink-soft)">让我先认识一下你</p>
        </div>

        <div class="space-y-5 px-6 pb-6">
          <label class="flex flex-col gap-1.5">
            <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
              <User class="h-3.5 w-3.5" /> 你的名字
            </span>
            <input v-model="name" @keydown.enter="handleSave" placeholder="输入你的名字或昵称…" maxlength="20"
              class="w-full rounded-xl border bg-white px-3 py-2.5 text-sm outline-none transition-colors"
              style="border-color: var(--line); color: var(--ink)"
              @focus="($event.target as HTMLElement).style.borderColor = 'var(--accent)'"
              @blur="($event.target as HTMLElement).style.borderColor = 'var(--line)'"
            />
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
              <GraduationCap class="h-3.5 w-3.5" /> 当前年级
            </span>
            <select v-model="grade"
              class="w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-semibold outline-none transition-colors"
              style="border-color: var(--line); color: var(--ink); appearance: none"
              @focus="($event.target as HTMLElement).style.borderColor = 'var(--accent)'"
              @blur="($event.target as HTMLElement).style.borderColor = 'var(--line)'"
            >
              <template v-for="grp in GRADE_GROUPS" :key="grp.band">
                <option disabled style="font-weight: 700; color: var(--ink-soft)">{{ grp.band }}</option>
                <option v-for="g in grp.items" :key="g.value" :value="g.value">{{ g.label }}</option>
              </template>
            </select>
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
              <Sparkles class="h-3.5 w-3.5" /> 对话模型
            </span>
            <div class="flex gap-2">
              <button @click="modelProvider = 'default'"
                class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97]"
                :class="modelProvider === 'default' ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'"
              ><span>Kimi K2.6</span></button>
              <button @click="modelProvider = 'deepseek'"
                class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97]"
                :class="modelProvider === 'deepseek' ? 'border-[#4A6CF7] bg-[#e8edff] text-[#2b4ad0]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[#4A6CF7]'"
              ><span>DeepSeek V4 Flash</span></button>
            </div>
          </label>
        </div>

        <div class="flex justify-center px-6 pb-8">
          <button @click="handleSave" :disabled="!name.trim()"
            class="btn-accent flex items-center gap-2 rounded-2xl px-8 py-2.5 font-display text-sm font-semibold"
          ><Sparkles class="h-4 w-4" /> 开始学习</button>
        </div>
      </div>
    </div>
  </div>
</template>
