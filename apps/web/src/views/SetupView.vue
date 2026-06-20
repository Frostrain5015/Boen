<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Grade } from '@boen/shared';
import { ArrowLeft, User, GraduationCap, Sparkles, Type, Mail, Crown, Save } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const isFirstSetup = computed(() => !authStore.userProfile);

const GRADE_GROUPS: { band: string; items: { value: Grade; label: string }[] }[] = [
  { band: '小学', items: ['一', '二', '三', '四', '五', '六'].map((c, i) => ({ value: String(i + 1) as Grade, label: `${c}年级` })) },
  { band: '初中', items: ['一', '二', '三'].map((c, i) => ({ value: String(i + 7) as Grade, label: `初${c}` })) },
  { band: '其他', items: [{ value: 'high', label: '高中' }, { value: 'college', label: '大学及以上' }] },
];

function detectBand(g: Grade): string {
  for (const group of GRADE_GROUPS) {
    if (group.items.some(i => i.value === g)) return group.band;
  }
  return '初中';
}

const name = ref(authStore.userProfile?.name ?? '');
const grade = ref<Grade>(authStore.userProfile?.grade ?? '8');
const selectedBand = ref(detectBand(grade.value));
const modelProvider = ref(localStorage.getItem('boen_model_provider') || 'default');
const fontSize = ref<'sm' | 'md' | 'lg'>(
  (localStorage.getItem('boen_font_size') as 'sm' | 'md' | 'lg') || 'md',
);

const currentBandItems = computed(() =>
  GRADE_GROUPS.find(g => g.band === selectedBand.value)?.items ?? [],
);

const FONT_SIZE_OPTIONS = [
  { value: 'sm' as const, label: '小', px: '14px' },
  { value: 'md' as const, label: '中', px: '16px' },
  { value: 'lg' as const, label: '大', px: '18px' },
];

// 字体大小实时预览
watch(fontSize, (val) => {
  localStorage.setItem('boen_font_size', val);
  document.documentElement.setAttribute('data-fontsize', val);
}, { immediate: true });

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
  if (isFirstSetup.value) {
    router.push('/');
  } else {
    router.push('/');
  }
}

function handleBack() {
  if (!isFirstSetup.value) router.push('/');
}
</script>

<template>
  <div class="flex min-h-full flex-col items-center p-6 pt-8">
    <div class="w-full max-w-lg">
      <!-- 头部 -->
      <div class="mb-6 flex items-center gap-3">
        <button
          v-if="!isFirstSetup"
          @click="handleBack"
          class="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50"
        >
          <ArrowLeft class="h-5 w-5" style="color: var(--ink-soft)" />
        </button>
        <div>
          <h1 class="font-display text-xl font-bold" style="color: var(--ink)">
            {{ isFirstSetup ? '初始设置' : '设置中心' }}
          </h1>
          <p class="text-sm" style="color: var(--ink-soft)">
            {{ isFirstSetup ? '让我们先认识一下你' : '个性化你的学习体验' }}
          </p>
        </div>
      </div>

      <div class="space-y-4">
        <!-- ═══ 个人信息 ═══ -->
        <div class="clay clay-glass overflow-hidden">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3">
            <User class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">个人信息</h2>
          </div>
          <div class="space-y-4 px-5 py-4">
            <!-- 头像 + 账号 -->
            <div class="flex items-center gap-3">
              <div class="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--accent-soft)]">
                <img
                  v-if="authStore.currentUser?.picture"
                  :src="authStore.currentUser.picture"
                  :alt="authStore.currentUser.username"
                  class="h-full w-full object-cover"
                />
                <User v-else class="h-5 w-5 text-[var(--accent-strong)]" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-bold text-[var(--ink)]">{{ authStore.currentUser?.username ?? '用户' }}</p>
                <div class="flex items-center gap-1.5 text-xs text-[var(--ink-soft)]">
                  <Mail class="h-3 w-3" />
                  {{ authStore.currentUser?.email ?? '' }}
                </div>
              </div>
              <span v-if="authStore.isPremium" class="badge-premium shrink-0">
                <Crown class="h-3 w-3" /> 会员
              </span>
            </div>
            <!-- 名字 -->
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
          </div>
        </div>

        <!-- ═══ 学习配置 ═══ -->
        <div class="clay clay-glass overflow-hidden">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3">
            <GraduationCap class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">学习配置</h2>
          </div>
          <div class="space-y-4 px-5 py-4">
            <div class="flex flex-col gap-3">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
                <GraduationCap class="h-3.5 w-3.5" /> 当前年级
              </span>
              <!-- 第一行：学段 -->
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="group in GRADE_GROUPS"
                  :key="group.band"
                  @click="selectedBand = group.band"
                  class="flex h-10 items-center justify-center rounded-2xl border-2 text-xs font-bold transition-all active:scale-[0.97]"
                  :class="selectedBand === group.band
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                    : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'"
                >{{ group.band }}</button>
              </div>
              <!-- 第二行：具体年级 -->
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="item in currentBandItems"
                  :key="item.value"
                  @click="grade = item.value"
                  class="flex h-9 items-center justify-center rounded-xl px-3.5 text-xs font-bold transition-all active:scale-[0.97]"
                  :class="grade === item.value
                    ? 'bg-[var(--accent)] text-white shadow-sm'
                    : 'bg-[var(--paper)] text-[var(--ink-soft)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"
                >{{ item.label }}</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ═══ 应用偏好 ═══ -->
        <div class="clay clay-glass overflow-hidden">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3">
            <Sparkles class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">应用偏好</h2>
          </div>
          <div class="space-y-5 px-5 py-4">
            <!-- 对话模型 -->
            <div class="flex flex-col gap-2">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
                <Sparkles class="h-3.5 w-3.5" /> 对话模型
              </span>
              <div class="flex flex-wrap gap-2">
                <button @click="modelProvider = 'deepseek'"
                  class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97] min-w-[130px]"
                  :class="modelProvider === 'deepseek' ? 'border-[#4A6CF7] bg-[#e8edff] text-[#2b4ad0]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[#4A6CF7]'"
                ><span>DeepSeek V4 Flash</span></button>
                <button v-if="authStore.isPremium" @click="modelProvider = 'deepseek-pro'"
                  class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97] min-w-[130px]"
                  :class="modelProvider === 'deepseek-pro' ? 'border-[#4A6CF7] bg-[#e8edff] text-[#2b4ad0]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[#4A6CF7]'"
                ><span>⭐ DeepSeek V4 Pro</span></button>
              </div>
            </div>

            <!-- 字体大小 -->
            <div class="flex flex-col gap-2">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
                <Type class="h-3.5 w-3.5" /> 字体大小
              </span>
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="opt in FONT_SIZE_OPTIONS"
                  :key="opt.value"
                  @click="fontSize = opt.value"
                  class="flex flex-col items-center gap-1 rounded-2xl border-2 py-3 transition-all active:scale-[0.97]"
                  :class="fontSize === opt.value
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                    : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'"
                >
                  <span class="font-display font-bold" :style="{ fontSize: opt.px }">{{ opt.label }}</span>
                  <span class="text-[10px] opacity-60">{{ opt.px }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- ═══ 保存 ═══ -->
        <div class="flex justify-center pb-8 pt-2">
          <button
            @click="handleSave"
            :disabled="!name.trim()"
            class="btn-accent flex items-center gap-2 rounded-2xl px-8 py-2.5 font-display text-sm font-semibold disabled:opacity-50"
          >
            <Save class="h-4 w-4" />
            {{ isFirstSetup ? '开始学习' : '保存设置' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
