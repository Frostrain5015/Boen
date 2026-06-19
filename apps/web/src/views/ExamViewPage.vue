<script setup lang="ts">
import { useRouter } from 'vue-router';
import { FileText } from 'lucide-vue-next';
import ExamView from '@/components/ExamView.vue';
import PremiumGate from '@/components/PremiumGate.vue';
import { useExamStore } from '@/stores/exam';

const router = useRouter();
const examStore = useExamStore();

function handleBack() {
  examStore.pendingExamNotes = null;
  examStore.pendingExamConfig = null;
  router.push('/');
}

function handleRefresh() {
  examStore.loadExams();
}
</script>

<template>
  <PremiumGate feature-name="AI 智能考试" :icon="FileText">
    <ExamView
      :key="`exam-${examStore.examViewKey}`"
      class="flex-1"
      :auto-notes="examStore.pendingExamNotes ?? undefined"
      :initial-config="examStore.pendingExamConfig ?? undefined"
      @back="handleBack"
      @refresh="handleRefresh"
    />
  </PremiumGate>
</template>
