<script setup lang="ts">
import { useRouter } from 'vue-router';
import ExamReview from '@/components/ExamReview.vue';

defineProps<{
  id: string;
}>();

const router = useRouter();

function handleBack() {
  router.push('/');
}
</script>

<template>
  <ExamReview class="flex-1" :exam-id="id" @back="handleBack" />
</template>
