<script setup lang="ts">
import { useRouter } from 'vue-router';
import { BrainCircuit } from 'lucide-vue-next';
import KnowledgeProfile from '@/components/KnowledgeProfile.vue';
import PremiumGate from '@/components/PremiumGate.vue';
import { useUiStore } from '@/stores/ui';
import { useExamStore } from '@/stores/exam';
import { useChatStore } from '@/stores/chat';
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

function handleExplore(detail: { title: string; subject: Subject; grade: string }) {
  router.push('/');
  uiStore.subject = detail.subject as any;
  setTimeout(() => {
    const chatStore = useChatStore();
    chatStore.send(`探索学习：${detail.title}`);
  }, 100);
}
</script>

<template>
  <PremiumGate feature-name="知识画像分析" :icon="BrainCircuit">
    <KnowledgeProfile class="flex-1" @back="handleBack" @practice="handlePractice" @exam="handleExam" @explore="handleExplore" />
  </PremiumGate>
</template>
