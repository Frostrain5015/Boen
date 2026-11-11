<script setup lang="ts">
import { ref, watch } from 'vue';
import { GRADES, gradeLabel, isGrade, type Grade } from '@boen/shared';
import { useAuthStore } from '@/stores/auth';

defineProps<{ onboarding?: boolean }>();
const auth = useAuthStore();
const selected = ref<Grade | ''>(auth.grade ?? '');
const saving = ref(false);
const error = ref('');
const groups = [
  { label: '小学', grades: GRADES.slice(0, 6) },
  { label: '初中', grades: GRADES.slice(6, 9) },
  { label: '其他', grades: GRADES.slice(9) },
];

watch(() => auth.grade, grade => { selected.value = grade ?? ''; });

async function save() {
  if (saving.value || !isGrade(selected.value) || selected.value === auth.grade) return;
  saving.value = true;
  error.value = '';
  try {
    await auth.saveGrade(selected.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '年级未保存，请重试';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <p v-if="auth.gradeStatus === 'loading'" role="status" class="text-sm text-[var(--ink-soft)]">正在读取年级…</p>
  <div v-else-if="auth.gradeStatus === 'error'" class="space-y-3">
    <p role="alert" class="text-sm text-[var(--ink-soft)]">无法读取年级，请重试。</p>
    <button type="button" class="btn-accent rounded-xl px-4 py-2 text-sm font-semibold" @click="auth.loadLearningProfile()">重试</button>
  </div>
  <form v-else class="space-y-3" @submit.prevent="save">
    <label for="learning-grade" class="block text-sm font-semibold">当前年级</label>
    <select
      id="learning-grade"
      v-model="selected"
      required
      :disabled="saving"
      class="block w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm"
      @change="error = ''"
    >
      <option disabled value="">请选择年级</option>
      <optgroup v-for="group in groups" :key="group.label" :label="group.label">
        <option v-for="grade in group.grades" :key="grade" :value="grade">{{ gradeLabel(grade) }}</option>
      </optgroup>
    </select>
    <p v-if="error" role="alert" class="text-sm text-[var(--error)]">{{ error }}</p>
    <button
      type="submit"
      :disabled="!selected || selected === auth.grade || saving"
      class="btn-accent rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50"
    >{{ saving ? '保存中…' : onboarding ? '保存并继续' : '保存年级' }}</button>
  </form>
</template>
