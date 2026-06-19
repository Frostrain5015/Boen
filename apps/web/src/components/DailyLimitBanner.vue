<script setup lang="ts">
import { AlertCircle } from 'lucide-vue-next';
import { useToast } from '@/composables/useToast';

const toast = useToast();
defineProps<{ show: boolean }>();

function handleUpgrade() {
  toast.info('请联系管理员开通会员');
}
</script>

<template>
  <Transition name="slide-up">
    <div
      v-if="show"
      class="clay-sm flex w-full max-w-[480px] items-center gap-3 px-5 py-3"
    >
      <AlertCircle class="h-[18px] w-[18px] shrink-0" style="color: var(--error)" />
      <span class="flex-1 text-[0.85rem]" style="color: var(--ink)">
        今日免费对话次数已用完
      </span>
      <button
        @click="handleUpgrade"
        class="shrink-0 text-[0.85rem] font-semibold transition-all hover:underline"
        style="color: var(--premium-gold-strong)"
      >
        升级会员
      </button>
    </div>
  </Transition>
</template>
