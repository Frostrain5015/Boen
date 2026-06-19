<script setup lang="ts">
import { useRouter } from 'vue-router';
import ExamView from '@/components/ExamView.vue';
import { useExamStore } from '@/stores/exam';

const router = useRouter();
const examStore = useExamStore();

function handleBack() {
  examStore.pendingExamNotes = null;
  router.push('/');
}

function handleRefresh() {
  examStore.loadExams();
}
</script>

<template>
  <ExamView
    :key="`exam-${examStore.examViewKey}`"
    class="flex-1"
    :auto-notes="examStore.pendingExamNotes ?? undefined"
    @back="handleBack"
    @refresh="handleRefresh"
  />
</template>
