<script setup lang="ts">
import { AlertCircle, X } from 'lucide-vue-next';
import { useToast } from '@/composables/useToast';

const toast = useToast();
defineProps<{ show: boolean }>();
const emit = defineEmits<{ close: [] }>();

function handleUpgrade() {
  toast.info('请联系管理员激活星月卡');
}
</script>

<template>
  <Transition name="slide-up">
    <div
      v-if="show"
      class="clay-sm flex w-full items-center gap-3 px-5 py-3"
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
        升级星月卡
      </button>
      <button
        @click="emit('close')"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-black/10"
        aria-label="关闭"
      >
        <X class="h-4 w-4" style="color: var(--ink-soft)" />
      </button>
    </div>
  </Transition>
</template>
