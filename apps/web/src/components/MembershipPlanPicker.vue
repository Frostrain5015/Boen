<script setup lang="ts">
import type { MembershipPlanKey, PurchasablePlan } from '@boen/shared';

defineProps<{
  plans: readonly PurchasablePlan[];
  disabled?: boolean;
}>();

const selected = defineModel<MembershipPlanKey>({ required: true });
</script>

<template>
  <fieldset :disabled="disabled" class="grid grid-cols-2 gap-2.5">
    <legend class="sr-only">选择计费方案</legend>
    <label
      v-for="plan in plans"
      :key="plan.key"
      class="relative cursor-pointer rounded-2xl border-2 p-3 text-center transition-all focus-within:ring-2 focus-within:ring-[var(--accent)] select-none"
      :class="selected === plan.key
        ? 'border-[var(--accent)] bg-[var(--accent-soft)]/50 shadow-xs'
        : 'border-[var(--line)] bg-[var(--paper)] hover:border-[#ded1be]'"
    >
      <span
        v-if="plan.key === 'yearly'"
        class="absolute -top-2 right-2 rounded-md bg-[#f59e0b] px-1.5 py-0.5 text-[10px] font-bold text-white shadow-xs"
      >
        立省 16%
      </span>
      <input v-model="selected" :value="plan.key" type="radio" name="membership-plan" class="sr-only" />
      <span class="block font-display text-sm font-bold text-[var(--ink)]">{{ plan.name }}</span>
      <div class="mt-1 flex items-baseline justify-center gap-0.5">
        <span class="font-display text-base font-bold text-[var(--ink)]">${{ plan.amount }}</span>
        <span class="text-xs text-[var(--ink-soft)]">/{{ plan.intervalLabel }}</span>
      </div>
      <span class="mt-0.5 block text-xs text-[var(--ink-soft)]">
        {{ plan.key === 'yearly' ? '相当于每月 $2.50' : '支持随时取消' }}
      </span>
    </label>
  </fieldset>
</template>
