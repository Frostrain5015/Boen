<script setup lang="ts">
import { ref, watch } from 'vue';
import { ArrowLeft, User, GraduationCap, Sparkles, Type, Mail, Lock } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/services/auth';
import { useToast } from '@/composables/useToast';
import MembershipPanel from '@/components/MembershipPanel.vue';
import LearningGradeSetting from '@/components/LearningGradeSetting.vue';
const authStore = useAuthStore();
const toast = useToast();
const name = ref(authStore.profileName);
const modelProvider = ref(localStorage.getItem('boen_model_provider') || 'default');
const fontSize = ref<'sm' | 'md' | 'lg'>(
  (localStorage.getItem('boen_font_size') as 'sm' | 'md' | 'lg') || 'md',
);

const FONT_SIZE_OPTIONS = [
  { value: 'sm' as const, label: '小', px: '14px' },
  { value: 'md' as const, label: '中', px: '16px' },
  { value: 'lg' as const, label: '大', px: '18px' },
];

/** 选择模型：非星月卡点 DS 弹窗，否则立即切换+保存 */
function setProvider(val: string) {
  if (val !== 'default' && !authStore.isPremium) {
    toast.info('该功能为星月卡专属');
    return;
  }
  modelProvider.value = val;
  localStorage.setItem('boen_model_provider', val);
  fetch('/api/model/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
    body: JSON.stringify({ provider: val }),
  }).catch(() => {});
}

/** 名称失焦时自动保存 */
function onNameBlur() {
  if (name.value.trim()) authStore.saveName(name.value.trim());
}

// 字体大小实时预览 + 保存
watch(fontSize, (val) => {
  localStorage.setItem('boen_font_size', val);
  document.documentElement.setAttribute('data-fontsize', val);
}, { immediate: true });

</script>
<template>
  <div class="flex h-full min-h-0 flex-col overflow-y-auto p-4 pt-6 sm:p-6 sm:pt-8">
    <!-- 头部 -->
    <div class="mb-6 flex items-center gap-3">
      <router-link
        to="/"
        aria-label="返回博文"
        class="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50"
      >
        <ArrowLeft class="h-5 w-5" style="color: var(--ink-soft)" />
      </router-link>
      <div>
        <h1 class="font-display text-xl font-bold" style="color: var(--ink)">
          个人中心
        </h1>
      </div>
    </div>

    <!-- 主体：左右布局 -->
    <div class="flex flex-col lg:flex-row flex-1 gap-6 max-w-[1000px] w-full mx-auto">


      <MembershipPanel class="w-full min-w-0 lg:w-[400px] lg:shrink-0" />
      <!-- ═══ 右侧：设置列表 ═══ -->
      <div class="flex-1 min-w-0 space-y-4">
        <!-- 个人信息 -->
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
            </div>
            <!-- 名字 -->
            <label class="flex flex-col gap-1.5">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
                <User class="h-3.5 w-3.5" /> 你的名字
              </span>
              <input v-model="name" @blur="onNameBlur" placeholder="输入你的名字或昵称…" maxlength="20"
                class="w-full rounded-xl border bg-white px-3 py-2.5 text-sm outline-none transition-colors"
                style="border-color: var(--line); color: var(--ink)"
                @focus="($event.target as HTMLElement).style.borderColor = 'var(--accent)'"
              />
            </label>
          </div>
        </div>

        <!-- 学习配置 -->
        <div class="clay clay-glass overflow-hidden">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3">
            <GraduationCap class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">学习配置</h2>
          </div>
          <div class="px-5 py-4">
            <LearningGradeSetting v-if="authStore.grade || authStore.gradeStatus !== 'ready'" />
            <router-link v-else to="/" class="btn-accent inline-block rounded-xl px-4 py-2 text-sm font-semibold">选择年级</router-link>
          </div>
        </div>

        <!-- 应用偏好 -->
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
                <button @click="setProvider('default')"
                  class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97] min-w-[130px]"
                  :class="(modelProvider === 'default' || modelProvider === 'deepseek') ? 'border-[#4A6CF7] bg-[#e8edff] text-[#2b4ad0]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[#4A6CF7]'"
                ><span>DeepSeek V4 Flash</span></button>
                <button @click="setProvider('deepseek-pro')"
                  class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97] min-w-[130px]"
                  :class="(modelProvider === 'deepseek-pro' ? 'border-[#E8A317] bg-[#fef3d2] text-[#b8730d]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)]') + (!authStore.isPremium ? ' opacity-40 cursor-not-allowed' : ' hover:border-[#E8A317]')"
                  :disabled="!authStore.isPremium"
                ><span v-if="!authStore.isPremium"><Lock class="inline h-3 w-3 mr-0.5" /></span>DeepSeek V4 Pro</button>
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

        <div class="pb-8"></div>
      </div>
    </div>


  </div>
</template>
