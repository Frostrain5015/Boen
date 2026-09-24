<script setup lang="ts">
import type { MembershipPlanKey, PurchasablePlan } from '@boen/shared';
defineProps<{ plans: readonly PurchasablePlan[]; disabled?: boolean }>();
const selected = defineModel<MembershipPlanKey>({ required: true });
</script>
<template>
  <fieldset :disabled="disabled" class="grid grid-cols-2 gap-3">
    <legend class="sr-only">选择计费方案</legend>
    <label v-for="plan in plans" :key="plan.key"
      class="cursor-pointer rounded-2xl border px-3 py-3 text-center transition-colors focus-within:ring-2 focus-within:ring-[var(--accent)]"
      :class="selected === plan.key ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-[var(--paper)]'">
      <input v-model="selected" :value="plan.key" type="radio" name="membership-plan" class="sr-only" />
      <span class="block font-display text-sm font-bold">{{ plan.name }}</span>
      <span class="mt-1 block text-xs text-[var(--ink-soft)]">USD ${{ plan.amount }} / {{ plan.intervalLabel }}</span>
    </label>
  </fieldset>
</template>
