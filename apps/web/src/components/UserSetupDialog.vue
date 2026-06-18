<script setup lang="ts">
import { ref } from 'vue';
import type { Grade } from '@boen/shared';
import { Sparkles, User, GraduationCap } from 'lucide-vue-next';

const props = defineProps<{
  profile: { name: string; grade: Grade } | null;
}>();

const emit = defineEmits<{
  save: [profile: { name: string; grade: Grade }];
}>();

/** 分组年级选择：小学 1–6 / 初中 7–9 细化，高中、大学为粗档 */
const GRADE_GROUPS: { band: string; items: { value: Grade; label: string }[] }[] = [
  { band: '小学', items: ['一', '二', '三', '四', '五', '六'].map((c, i) => ({ value: String(i + 1) as Grade, label: `${c}年级` })) },
  { band: '初中', items: ['七', '八', '九'].map((c, i) => ({ value: String(i + 7) as Grade, label: `${c}年级` })) },
  { band: '其他', items: [{ value: 'high', label: '高中' }, { value: 'college', label: '大学及以上' }] },
];

const name = ref(props.profile?.name ?? '');
const grade = ref<Grade>(props.profile?.grade ?? '8');
const saved = ref(false);

function handleSave() {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  emit('save', { name: trimmed, grade: grade.value });
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

          <!-- 年级（下拉菜单） -->
          <label class="setup-field">
            <span class="setup-label">
              <GraduationCap class="h-3.5 w-3.5" />
              当前年级
            </span>
            <select v-model="grade" class="setup-select">
              <template v-for="grp in GRADE_GROUPS" :key="grp.band">
                <option disabled class="setup-optgroup-label">{{ grp.band }}</option>
                <option v-for="g in grp.items" :key="g.value" :value="g.value" class="setup-option">{{ g.label }}</option>
              </template>
            </select>
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
.setup-select {
  width: 100%;
  padding: 0.6rem 0.85rem;
  border-radius: 14px;
  border: 1.5px solid var(--line);
  background: #fff;
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23786a5d' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.75rem center;
  padding-right: 2rem;
}
.setup-select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.setup-optgroup-label {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--ink-soft);
  background: var(--surface);
  cursor: default;
}
.setup-option {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--ink);
}
.setup-footer {
  display: flex;
  justify-content: center;
  padding: 0.5rem 2rem 2rem;
}
</style>
