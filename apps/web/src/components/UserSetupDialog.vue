<script setup lang="ts">
import { ref } from 'vue';
import type { GradeBand } from '@boen/shared';
import { Sparkles, User, GraduationCap } from 'lucide-vue-next';

const props = defineProps<{
  profile: { name: string; gradeBand: GradeBand } | null;
}>();

const emit = defineEmits<{
  save: [profile: { name: string; gradeBand: GradeBand }];
}>();

const GRADES: { value: GradeBand; label: string; desc: string }[] = [
  { value: 'primary', label: '小学', desc: '1–6 年级' },
  { value: 'middle', label: '中学', desc: '7–12 年级' },
  { value: 'undergrad', label: '大学及以上', desc: '本科 / 研究生' },
];

const name = ref(props.profile?.name ?? '');
const gradeBand = ref<GradeBand>(props.profile?.gradeBand ?? 'middle');
const saved = ref(false);

function handleSave() {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  emit('save', { name: trimmed, gradeBand: gradeBand.value });
  saved.value = true;
}
</script>

<template>
  <Teleport to="body">
    <div class="setup-overlay">
      <div
        class="setup-card clay"
        v-motion
        :initial="{ opacity: 0, scale: 0.92, y: 20 }"
        :enter="{ opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 260, damping: 22 } }"
      >
        <!-- 头部 -->
        <div class="setup-header">
          <div class="setup-avatar">
            <Sparkles class="h-6 w-6" />
          </div>
          <h2 class="setup-title">欢迎来到博文</h2>
          <p class="setup-desc">让我先认识一下你，为你提供更贴心的学习陪伴</p>
        </div>

        <!-- 表单 -->
        <div class="setup-body">
          <!-- 名字 -->
          <label class="setup-field">
            <span class="setup-label">
              <User class="h-3.5 w-3.5" />
              你的名字
            </span>
            <input
              v-model="name"
              @keydown.enter="handleSave"
              placeholder="输入你的名字或昵称…"
              class="setup-input"
              maxlength="20"
            />
          </label>

          <!-- 年级 -->
          <label class="setup-field">
            <span class="setup-label">
              <GraduationCap class="h-3.5 w-3.5" />
              当前年级
            </span>
            <div class="setup-grades">
              <button
                v-for="g in GRADES"
                :key="g.value"
                @click="gradeBand = g.value"
                class="setup-grade"
                :class="gradeBand === g.value ? 'grade-on' : 'grade-off'"
              >
                <span class="grade-label">{{ g.label }}</span>
                <span class="grade-desc">{{ g.desc }}</span>
              </button>
            </div>
          </label>
        </div>

        <!-- 底部 -->
        <div class="setup-footer">
          <button
            @click="handleSave"
            :disabled="!name.trim()"
            class="btn-accent flex items-center gap-2 rounded-2xl px-7 py-2.5 font-display text-sm font-semibold"
          >
            <Sparkles class="h-4 w-4" />
            {{ props.profile ? '保存设置' : '开始学习' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.setup-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  background: rgba(44, 39, 34, 0.35);
  backdrop-filter: blur(6px);
  padding: 1rem;
}
.setup-card {
  width: 100%;
  max-width: 380px;
  overflow: hidden;
  background: var(--surface);
}
.setup-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 2rem 2rem 0;
  text-align: center;
}
.setup-avatar {
  display: grid;
  place-items: center;
  width: 3.25rem;
  height: 3.25rem;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-strong);
  margin-bottom: 0.2rem;
}
.setup-title {
  font-family: var(--font-display);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--ink);
}
.setup-desc {
  font-size: 0.82rem;
  color: var(--ink-soft);
  line-height: 1.4;
}
.setup-body {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.5rem 2rem;
}
.setup-field {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.setup-label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--font-display);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--ink-soft);
}
.setup-input {
  width: 100%;
  padding: 0.6rem 0.85rem;
  border-radius: 14px;
  border: 1.5px solid var(--line);
  background: #fff;
  font-size: 0.95rem;
  transition: border-color 0.2s, box-shadow 0.2s;
  box-sizing: border-box;
}
.setup-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.setup-input::placeholder { color: var(--ink-soft); opacity: 0.5; }
.setup-grades {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0.5rem;
}
.setup-grade {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  padding: 0.65rem 0.4rem;
  border-radius: 14px;
  border: 1.5px solid var(--line);
  background: #fff;
  cursor: pointer;
  transition: transform 0.15s, border-color 0.2s, background-color 0.2s;
}
.setup-grade:hover { transform: translateY(-2px); }
.grade-on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.grade-off { }
.grade-label {
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--ink);
}
.grade-on .grade-label { color: var(--accent-strong); }
.grade-desc {
  font-size: 0.62rem;
  color: var(--ink-soft);
  white-space: nowrap;
}
.setup-footer {
  display: flex;
  justify-content: center;
  padding: 0.5rem 2rem 2rem;
}
</style>
