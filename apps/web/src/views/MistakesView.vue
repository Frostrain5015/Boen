<script setup lang="ts">
import { useRouter } from 'vue-router';
import MistakeBook from '@/components/MistakeBook.vue';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import type { Subject } from '@/stores/chat';

const router = useRouter();
const authStore = useAuthStore();
const uiStore = useUiStore();

function handleBack() {
  router.push('/');
}

function handlePractice(detail: { prompt: string; subject: Subject; grade: string }) {
  router.push('/');
  uiStore.handleMistakePractice(detail);
}
</script>

<template>
  <MistakeBook
    class="flex-1"
    :grade="authStore.userProfile?.grade ?? '7'"
    :initial-subject="uiStore.subject"
    @back="handleBack"
    @practice="handlePractice"
  />
</template>
