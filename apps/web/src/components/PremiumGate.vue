<script setup lang="ts">
import { type Component } from 'vue';
import { useRouter } from 'vue-router';
import { Lock } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const props = defineProps<{
  featureName: string;
  icon?: Component;
}>();

function handleActivate() {
  router.push('/setup');
}
</script>

<template>
  <slot v-if="authStore.isPremium" />

  <div v-else class="relative h-full w-full">
    <div class="premium-overlay">
      <div class="flex flex-col items-center gap-4">
        <div class="flex h-14 w-14 items-center justify-center rounded-2xl"
          style="background: var(--locked-surface); border: 1.5px solid var(--locked-line)">
          <component v-if="icon" :is="icon" class="h-7 w-7" style="color: var(--locked-ink)" />
          <Lock v-else class="h-7 w-7" style="color: var(--locked-ink)" />
        </div>
        <p class="font-display text-lg font-bold" style="color: var(--ink)">该功能为星月卡专属</p>
        <button @click="handleActivate"
          class="rounded-full px-6 py-2.5 text-sm font-semibold text-white transition-all"
          style="background: linear-gradient(180deg, var(--premium-gold) 0%, var(--premium-gold-strong) 100%);
            box-shadow: 0 10px 20px -10px var(--premium-gold-glow),
                        inset 0 -2px 0 rgba(0,0,0,0.12),
                        inset 0 1px 0 rgba(255,255,255,0.28);"
        >点击激活</button>
      </div>
    </div>

    <div class="invisible"><slot /></div>
  </div>
</template>
