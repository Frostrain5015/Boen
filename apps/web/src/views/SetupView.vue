<script setup lang="ts">
import { ref } from 'vue';
import { ArrowLeft, User, Mail, GraduationCap } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import MembershipPanel from '@/components/MembershipPanel.vue';
import LearningGradeSetting from '@/components/LearningGradeSetting.vue';

const authStore = useAuthStore();
const name = ref(authStore.profileName);

/** 名称失焦时自动保存 */
function onNameBlur() {
  if (name.value.trim()) authStore.saveName(name.value.trim());
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-y-auto p-4 pt-6 sm:p-6 sm:pt-8">
    <!-- 头部导航 -->
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

    <!-- 主体：左右均衡布局 -->
    <div class="flex flex-col lg:flex-row flex-1 gap-6 max-w-[1000px] w-full mx-auto">
      <!-- ═══ 左侧：会员与算力管理 ═══ -->
      <MembershipPanel class="w-full min-w-0 lg:w-[400px] lg:shrink-0" />

      <!-- ═══ 右侧：整合后的个人资料与学习配置（单一高集成卡片） ═══ -->
      <div class="flex-1 min-w-0 space-y-4">
        <div class="clay clay-glass overflow-hidden rounded-2xl">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3.5">
            <User class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">个人资料与学习配置</h2>
          </div>

          <div class="space-y-5 px-5 py-5">
            <!-- 头像 + 账号信息 -->
            <div class="flex items-center gap-3 pb-3 border-b border-[var(--line)]">
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

            <!-- 姓名输入 -->
            <label class="flex flex-col gap-1.5">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold text-[var(--ink-soft)]">
                <User class="h-3.5 w-3.5" /> 你的名字
              </span>
              <input
                v-model="name"
                @blur="onNameBlur"
                placeholder="输入你的名字或昵称…"
                maxlength="20"
                class="w-full rounded-xl border bg-white px-3 py-2.5 text-sm outline-none transition-colors"
                style="border-color: var(--line); color: var(--ink)"
                @focus="($event.target as HTMLElement).style.borderColor = 'var(--accent)'"
              />
            </label>

            <!-- 学习年级配置 -->
            <div class="flex flex-col gap-1.5 pt-1">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold text-[var(--ink-soft)]">
                <GraduationCap class="h-3.5 w-3.5" /> 所属年级
              </span>
              <LearningGradeSetting v-if="authStore.grade || authStore.gradeStatus !== 'ready'" />
              <router-link v-else to="/" class="btn-accent inline-block rounded-xl px-4 py-2 text-sm font-semibold">选择年级</router-link>
            </div>
          </div>
        </div>

        <div class="pb-8" />
      </div>
    </div>
  </div>
</template>
