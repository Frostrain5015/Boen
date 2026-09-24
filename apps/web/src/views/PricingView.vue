<script setup lang="ts">
import { computed, ref } from 'vue';
import { MEMBERSHIP_PLANS, type MembershipPlanKey } from '@boen/shared';
import { ArrowLeft, ArrowUpRight, ScanLine, Sparkles, BookOpen, ChartNoAxesCombined, Check } from 'lucide-vue-next';
import MembershipCard from '@/components/MembershipCard.vue';
import MembershipPlanPicker from '@/components/MembershipPlanPicker.vue';
const selectedPlanKey = ref<MembershipPlanKey>('monthly');
const selectedPlan = computed(() => MEMBERSHIP_PLANS.find(plan => plan.key === selectedPlanKey.value)!);
const features = [
  { icon: ScanLine, title: '把一道题，变成一次进步', body: '拍照或输入题目，用 OCR 整理试题内容，再逐步理解解题思路。' },
  { icon: BookOpen, title: '练习有方向，错题有回响', body: '按学科学习和练习，整理错题，借助智能归因找出容易卡住的地方。' },
  { icon: ChartNoAxesCombined, title: '看见知识一点点连接', body: '用考试结果和学习诊断了解知识掌握情况，安排下一次有针对性的练习。' },
];
</script>
<template>
  <div class="relative h-full overflow-y-auto text-[var(--ink)]">
    <div class="app-bg" aria-hidden="true" /><div class="app-grain" aria-hidden="true" />
    <main class="relative z-10 mx-auto max-w-5xl px-5 py-7 sm:px-8 sm:py-10">
      <nav class="flex items-center justify-between gap-4 text-sm"><router-link to="/" class="inline-flex items-center gap-1 text-[var(--ink-soft)]"><ArrowLeft :size="15" />返回博文</router-link><span class="brand-text font-bold">博文 Boen</span></nav>
      <div class="grid grid-cols-1 items-center gap-10 py-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-16 lg:py-16">
        <section>
          <p class="font-display text-xs font-bold tracking-widest text-[var(--accent-strong)]">陪伴每一次求知</p>
          <h1 class="font-display mt-4 text-4xl font-bold leading-tight sm:text-5xl">让学习，<br />有迹可循。</h1>
          <p class="mt-6 max-w-md text-base leading-8 text-[var(--ink-soft)]">博文是面向学生与自主学习者的 AI 学习工具。从一道不懂的题，到一次有准备的练习，让知识在理解中慢慢连起来。</p>
          <div class="mt-7 flex flex-wrap gap-3"><router-link to="/" class="btn-accent inline-flex items-center gap-2 rounded-2xl px-5 py-3 font-display text-sm font-bold">登录，开始学习<ArrowUpRight :size="15" /></router-link><a href="#membership" class="rounded-2xl border border-[var(--line)] px-5 py-3 text-sm text-[var(--ink-soft)]">了解星月卡</a></div>
          <p class="mt-4 text-xs leading-6 text-[var(--ink-soft)]">可先使用免费基础对话，每日 10 次。AI 输出可能有误，请结合教材与教师指导核对。</p>
        </section>
        <section id="membership" class="clay clay-glass p-5 sm:p-6" aria-label="星月卡定价">
          <MembershipCard :type="selectedPlanKey" size="lg" :show-price="false" status-label="为求知，多一份陪伴" />
          <p class="mt-3 text-center text-xs text-[var(--ink-soft)]">轻触卡面，查看会员权益</p>
          <MembershipPlanPicker v-model="selectedPlanKey" :plans="MEMBERSHIP_PLANS" class="mt-6" />
          <div class="mt-6 flex items-end justify-between"><h2 class="font-display text-lg font-bold">{{ selectedPlan.name }}</h2><p><span class="font-display text-3xl font-bold">${{ selectedPlan.amount }}</span><span class="ml-1 text-sm text-[var(--ink-soft)]">USD / {{ selectedPlan.intervalLabel }}</span></p></div>
          <ul class="my-5 space-y-2 text-sm text-[var(--ink-soft)]"><li v-for="benefit in ['DeepSeek V4 Pro 大模型', '全题型考试与错题智能归因', '学习诊断报告']" :key="benefit" class="flex items-center gap-2"><Check :size="15" class="text-[var(--accent-strong)]" />{{ benefit }}</li></ul>
          <router-link :to="{ path: '/setup', query: { plan: selectedPlanKey } }" class="btn-accent block rounded-2xl px-4 py-3 text-center font-display text-sm font-bold">登录后订阅{{ selectedPlan.name }}</router-link>
          <p class="mt-4 text-xs leading-6 text-[var(--ink-soft)]">首次订阅享 7 天免费试用；结束后按 USD ${{ selectedPlan.amount }}/{{ selectedPlan.intervalLabel }} 自动续费，直至取消。年付方案按年一次收取 USD $29.99，并非每月扣款。两种方案权益相同，每个账户仅一次试用。税费以 Waffo 收银台为准。</p>
        </section>
      </div>
      <section class="grid gap-4 md:grid-cols-3" aria-label="产品功能"><article v-for="feature in features" :key="feature.title" class="clay clay-glass p-6"><component :is="feature.icon" :size="23" class="text-[var(--accent-strong)]" /><h2 class="font-display mt-4 text-base font-bold">{{ feature.title }}</h2><p class="mt-3 text-sm leading-7 text-[var(--ink-soft)]">{{ feature.body }}</p></article></section>
      <section class="my-10 clay clay-glass p-6 sm:p-8"><h2 class="font-display text-xl font-bold"><Sparkles class="mr-2 inline h-5 w-5 text-[var(--premium-gold)]" />订阅之前，你可以了解这些</h2><div class="mt-6 grid gap-6 sm:grid-cols-2 text-sm leading-7 text-[var(--ink-soft)]">
        <div><h3 class="font-bold text-[var(--ink)]">随时取消，安心安排</h3><p>在个人中心 → 会员与订阅 → 取消自动续费即可在线取消。当前试用或已付周期内仍可使用，结束后不再自动扣款；在终止前可恢复续费。</p></div>
        <div><h3 class="font-bold text-[var(--ink)]">积累的奖励，留给以后的你</h3><p>2000 星月积分可兑换 30 天奖励会员。订阅期间暂停消耗，订阅结束后继续使用。积分不可购买、转让或提现。</p></div>
        <div><h3 class="font-bold text-[var(--ink)]">支付与退款</h3><p>Waffo Pancake 作为 Merchant of Record 处理结账、税费及账单。重复或错误扣款、付款后未交付、重大技术故障可申请退款；不提供一般无理由退款，法定权利不受影响。详见<router-link to="/terms" class="underline">服务条款</router-link>。</p></div>
        <div><h3 class="font-bold text-[var(--ink)]">有问题，随时写信</h3><p>由个人开发者潘涵宇（Pan Hanyu）运营，Frost Tech／寒霜科技为个人品牌，尚未注册企业主体。支持邮箱：<a class="underline break-all" href="mailto:phy55015@hotmail.com">phy55015@hotmail.com</a>。</p></div>
      </div></section>
      <footer class="flex flex-wrap justify-between gap-4 pb-5 text-xs text-[var(--ink-soft)]"><span>© 2026 Pan Hanyu · Frost Tech · 博文 Boen</span><div class="flex gap-5"><router-link to="/terms">服务条款</router-link><router-link to="/privacy">隐私政策</router-link></div></footer>
    </main>
  </div>
</template>
