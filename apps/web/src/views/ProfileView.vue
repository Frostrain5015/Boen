<script setup lang="ts">
import { useRouter } from 'vue-router';
import KnowledgeProfile from '@/components/KnowledgeProfile.vue';
import { useUiStore } from '@/stores/ui';
import { useExamStore } from '@/stores/exam';
import type { Subject } from '@/stores/chat';
import type { Grade } from '@boen/shared';

const router = useRouter();
const uiStore = useUiStore();
const examStore = useExamStore();

function handleBack() {
  router.push('/');
}

function handlePractice(detail: { kp?: string; subject: Subject; grade: string; mode?: string }) {
  router.push('/');
  uiStore.handlePractice(detail);
}

function handleExam(detail: { subject: Subject; grade: string; durationMinutes: number; notes: string }) {
  router.push('/exam');
  examStore.handleExam(detail);
}
</script>

<template>
  <KnowledgeProfile class="flex-1" @back="handleBack" @practice="handlePractice" @exam="handleExam" />
</template>
