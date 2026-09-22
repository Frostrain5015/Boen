<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowLeft } from 'lucide-vue-next';
import LegalDocument from '@/components/legal/LegalDocument.vue';

const route = useRoute();
const kind = computed<'terms' | 'privacy'>(() => route.name === 'privacy' ? 'privacy' : 'terms');
</script>

<template>
  <div class="relative min-h-full overflow-y-auto">
    <div class="app-bg" aria-hidden="true"></div>
    <div class="app-grain" aria-hidden="true"></div>

    <main class="relative z-10 mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      <nav class="mb-4 flex items-center justify-between gap-4 text-sm">
        <router-link to="/" class="inline-flex items-center gap-1.5 text-[var(--ink-soft)] hover:text-[var(--ink)]">
          <ArrowLeft class="h-4 w-4" />
          返回博文
        </router-link>
        <div class="flex items-center gap-4">
          <router-link to="/terms" class="text-[var(--ink-soft)] hover:text-[var(--ink)]" active-class="!text-[var(--accent-strong)] font-semibold">
            服务条款
          </router-link>
          <router-link to="/privacy" class="text-[var(--ink-soft)] hover:text-[var(--ink)]" active-class="!text-[var(--accent-strong)] font-semibold">
            隐私政策
          </router-link>
        </div>
      </nav>

      <div class="clay relative overflow-hidden px-5 py-7 sm:px-9 sm:py-10">
        <LegalDocument :kind="kind" />
      </div>

      <footer class="py-6 text-center text-xs text-[var(--ink-soft)]/70">
        © 2026 潘涵宇（Pan Hanyu）· Frost Tech（个人品牌）· 博文 Boen
      </footer>
    </main>
  </div>
</template>
