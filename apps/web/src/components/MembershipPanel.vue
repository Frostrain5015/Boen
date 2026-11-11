<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from 'vue';
import { CREDIT_TOP_UP, LEGACY_MEMBERSHIP_PLANS, MEMBERSHIP_PLANS, creditTopUpAmount, type MembershipPlanKey } from '@boen/shared';
import { useRoute, useRouter } from 'vue-router';
import { CreditCard, Sparkles, LoaderCircle, ArrowUpRight, RefreshCw } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/services/auth';
import { useToast } from '@/composables/useToast';
import MembershipCard from './MembershipCard.vue';
import MembershipPlanPicker from './MembershipPlanPicker.vue';

const auth = useAuthStore();
const toast = useToast();
const route = useRoute();
const router = useRouter();
const busy = ref(false);
const loadFailed = ref(false);
const agreed = ref(false);
const card = ref<InstanceType<typeof MembershipCard> | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
const action = ref<'cancel' | 'reactivate' | 'reward'>('cancel');
const sub = computed(() => auth.subscription);
const billing = computed(() => sub.value?.billing);
const selectedPlanKey = ref<MembershipPlanKey>(route.query.plan === 'pro' ? 'pro' : 'plus');
const selectedPlan = computed(() => MEMBERSHIP_PLANS.find(plan => plan.key === selectedPlanKey.value)!);
const plans = computed(() => sub.value?.plans ?? []);
const billedPlan = computed(() => [...MEMBERSHIP_PLANS, ...LEGACY_MEMBERSHIP_PLANS].find(plan => plan.key === billing.value?.planKey) ?? MEMBERSHIP_PLANS[0]);
const hasBilling = computed(() => billing.value && !['none', 'canceled'].includes(billing.value.status));
const priceLabel = computed(() => {
  if (hasBilling.value && billing.value) {
    const symbol = billing.value.currency === 'USD' ? '$' : `${billing.value.currency} `;
    return `${symbol}${billing.value.amount}/${billedPlan.value.intervalLabel}`;
  }
  return `$${selectedPlan.value.amount}/${selectedPlan.value.intervalLabel}`;
});
const cardType = computed(() => sub.value?.membership.legacyTier ?? (hasBilling.value ? billedPlan.value.key : sub.value?.membership.source === 'reward' ? 'monthly' : selectedPlanKey.value));
watch(selectedPlanKey, () => { agreed.value = false; });
const canBuy = computed(() => Boolean(sub.value?.payEnabled && billing.value?.checkoutAllowed));
const date = (value?: number | null) => value ? new Date(value * 1000).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '等待确认';
const labels = { none: '尚未开通', pending: '等待支付', trialing: '免费试用中', active: '订阅生效中', canceling: '已取消续费', past_due: '付款待处理', canceled: '订阅已结束' };
const statusLabel = computed(() => {
  if (sub.value?.membership.source === 'legacy') return '历史会员';
  if (sub.value?.membership.source === 'reward') return '积分奖励会员';
  return labels[billing.value?.status ?? 'none'];
});
const statusDetail = computed(() => {
  if (!sub.value) return '正在加载会员信息…';
  if (sub.value.membership.source === 'legacy') return `原有权益保留至 ${date(sub.value.expiresAt)}，到期后可订阅星月卡。`;
  if (billing.value?.status === 'trialing') return `首次扣款：${date(billing.value.renewsAt)}，之后 ${priceLabel.value} 自动续费。`;
  if (billing.value?.status === 'active') return `下次将在 ${date(billing.value.renewsAt)} 续费 ${priceLabel.value}，税费以账单为准。`;
  if (billing.value?.status === 'canceling') return `不再自动扣款，当前权益保留至 ${date(billing.value.currentPeriodEnd)}。`;
  if (billing.value?.status === 'past_due') return `未能完成扣款，请更新付款方式。已付权益截止 ${date(billing.value.currentPeriodEnd)}。`;
  if (sub.value.membership.source === 'reward') return `奖励会员有效期至 ${date(sub.value.expiresAt)}。`;
  return billing.value?.trialEligible ? `免费试用 7 天，结束后 ${priceLabel.value} 自动续费，可随时取消。` : `${priceLabel.value} 自动续费，可随时取消。`;
});
const confirmTitle = computed(() => action.value === 'reward' ? '兑换 30 天奖励会员' : action.value === 'cancel' ? '取消自动续费' : '恢复自动续费');
const confirmDetail = computed(() => action.value === 'reward'
  ? '消耗 2,000 历史奖励积分。已有订阅时，奖励时长保留至订阅结束后使用。'
  : action.value === 'cancel'
    ? `取消后不再自动扣款，当前权益保留至 ${date(billing.value?.currentPeriodEnd)}。付款失败且已过周期时，不会延长权益。`
    : `恢复后按 ${priceLabel.value} 自动续费，下一次扣款时间以 Waffo 账单为准。可再次取消。`);

async function refresh() {
  await Promise.all([auth.fetchSubscription(), auth.fetchCurrencyStatus()]);
  loadFailed.value = !auth.subscription;
}
async function buy() {
  if (busy.value || !agreed.value || !canBuy.value) return;
  busy.value = true;
  try {
    const result = await auth.createCheckout(selectedPlanKey.value);
    if (!result.ok || !result.checkoutUrl) { toast.error(result.message ?? '暂时无法创建订阅'); return; }
    // Same-tab navigation avoids popup blockers and duplicate checkout tabs.
    window.location.assign(result.checkoutUrl);
  } finally { busy.value = false; }
}
async function confirm(kind: 'cancel' | 'reactivate' | 'reward') {
  action.value = kind;
  await nextTick();
  dialog.value?.showModal();
}
async function execute() {
  if (busy.value) return;
  busy.value = true;
  try {
    if (action.value === 'reward') {
      const result = await auth.redeemMembershipWithPoints('month');
      if (!result.ok) { toast.error(result.message ?? '兑换未完成'); return; }
      toast.success('30 天奖励会员已入账');
    } else {
      const response = await fetch(`/api/payment/subscription/${action.value}`, {
        method: 'POST', headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      });
      const result = await response.json() as { ok?: boolean; message?: string };
      if (!response.ok || !result.ok) { toast.error(result.message ?? '操作未确认，请稍后刷新'); return; }
      toast.success(action.value === 'cancel' ? '已取消自动续费' : '已恢复自动续费');
    }
    await refresh();
    card.value?.playShimmer();
    dialog.value?.close();
  } catch { toast.error('网络连接失败，请刷新确认操作结果'); }
  finally { busy.value = false; }
}
const topUpPoints = ref<number>(CREDIT_TOP_UP.minimum);
const topUpPrice = computed(() => creditTopUpAmount(topUpPoints.value));
let topUpRequestId: string | null = null;
watch(topUpPoints, () => { topUpRequestId = null; });
async function topUp() {
  const token = getToken();
  if (busy.value || !token || !topUpPrice.value) return;
  topUpRequestId ??= crypto.randomUUID();
  busy.value = true;
  try {
    const response = await fetch('/api/payment/top-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ points: topUpPoints.value, requestId: topUpRequestId }),
    });
    const result = await response.json() as { checkoutUrl?: string; message?: string; error?: string };
    if (response.ok && result.checkoutUrl) window.location.assign(result.checkoutUrl);
    else {
      if (result.error === 'expired' || result.error === 'conflict') topUpRequestId = null;
      toast.error(result.message ?? '暂时无法创建充值订单');
    }
  } catch { toast.error('网络连接失败，请重试'); }
  finally { busy.value = false; }
}
async function confirmTopUp(requestId: string) {
  const token = getToken();
  if (!token) return;
  busy.value = true;
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await fetch(`/api/payment/top-up/${encodeURIComponent(requestId)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 404 || response.status === 401) break;
      if (response.ok) {
        const status = await response.json() as { state: string; points: number };
        if (status.state === 'paid') {
          await auth.fetchCurrencyStatus();
          toast.success('星月积分已到账');
          return;
        }
        if (status.state === 'refunded') break;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    toast.info('充值结果待确认，请稍后刷新');
  } catch { toast.info('充值结果待确认，请稍后刷新'); }
  finally {
    busy.value = false;
    await router.replace({ path: '/setup', hash: '#credits' });
  }
}
onMounted(async () => {
  window.addEventListener('focus', refresh);
  await refresh();
  if (route.hash === '#credits') document.getElementById('credits')?.scrollIntoView();
  if (route.query.topup === '1' && typeof route.query.requestId === 'string') await confirmTopUp(route.query.requestId);
  if (route.query.paid === '1') {
    await router.replace({ path: '/setup' });
    busy.value = true;
    try {
      const confirmed = await auth.pollSubscription();
      if (confirmed) { card.value?.playShimmer(); toast.success('星月卡已开通'); }
      else toast.info('订阅结果待确认，请稍后刷新');
    } finally { busy.value = false; }
  }
});
onUnmounted(() => window.removeEventListener('focus', refresh));
</script>

<template>
  <div class="membership-panel space-y-5">
    <section aria-labelledby="membership-heading" class="space-y-4">
      <div class="flex items-center justify-between gap-3 px-1">
        <h2 id="membership-heading" class="font-display text-sm font-bold text-[var(--ink)]">会员与订阅</h2>
        <button class="text-xs text-[var(--ink-soft)] inline-flex items-center gap-1 rounded-lg p-1" :disabled="busy" @click="refresh"><RefreshCw :size="12" />刷新</button>
      </div>
      <MembershipCard ref="card" :type="cardType" size="lg"
        :holder-name="auth.userProfile?.name ?? auth.currentUser?.username ?? ''" :expires-at="sub?.expiresAt"
        :show-price="false" :locked="!auth.isPremium" :status-label="statusLabel" />
      <p class="text-center text-xs text-[var(--ink-soft)]"><Sparkles class="inline mr-1 h-3 w-3" />翻面查看权益</p>
      <div class="clay clay-glass p-5 space-y-4" aria-live="polite">
        <template v-if="hasBilling">
          <div class="flex items-center justify-between gap-2">
            <span class="status-pill">{{ statusLabel }}</span>
            <span v-if="sub?.membership.source !== 'legacy' && sub?.membership.source !== 'reward'" class="text-sm font-semibold text-[var(--ink-soft)]">{{ priceLabel }}</span>
          </div>
          <p class="text-sm leading-6 text-[var(--ink-soft)]">{{ statusDetail }}</p>
        </template>
        <template v-else>
          <div class="flex items-center justify-between gap-2">
            <div>
              <h3 class="font-display text-sm font-bold text-[var(--ink)]">开通星月卡</h3>
              <p class="text-xs text-[var(--ink-soft)] mt-0.5">
                周额度在北京时间周一重置
              </p>
            </div>
            <span class="status-pill shrink-0">{{ statusLabel }}</span>
          </div>
        </template>
        <p v-if="loadFailed" class="text-sm text-[var(--error)]">会员信息加载失败，请刷新。</p>
        <template v-if="billing?.checkoutAllowed">
          <MembershipPlanPicker v-if="plans.length" v-model="selectedPlanKey" :plans="plans" :disabled="busy" />
          <label v-if="canBuy" class="flex items-start gap-2 text-xs leading-normal text-[var(--ink-soft)] cursor-pointer select-none pt-0.5">
            <input v-model="agreed" type="checkbox" class="mt-0.5 accent-[var(--accent)] shrink-0" />
            <span>
              我已阅读并同意 <router-link to="/terms" class="text-[var(--ink)] underline underline-offset-2">服务条款</router-link> 与 <router-link to="/privacy" class="text-[var(--ink)] underline underline-offset-2">隐私政策</router-link>，授权{{ billing.trialEligible ? '试用后' : '' }}按 {{ priceLabel }} 自动续费（到期前可随时取消）。未满 18 岁须经监护人同意。
            </span>
          </label>
          <button class="membership-primary w-full" :disabled="busy || !agreed || !canBuy" @click="buy">
            <LoaderCircle v-if="busy" :size="16" class="animate-spin" /><CreditCard v-else :size="16" />
            {{ !sub?.payEnabled ? '订阅暂未开放' : billing.trialEligible ? '开启 7 天免费试用' : `开通${selectedPlan.name}（${priceLabel}）` }}
          </button>
          <p v-if="sub?.membership.source === 'reward'" class="text-xs leading-5 text-[var(--ink-soft)]">订阅期间暂停消耗奖励时长，订阅结束后继续使用。</p>
        </template>
        <button v-if="billing && ['trialing','active','past_due'].includes(billing.status)" class="membership-secondary w-full" :disabled="busy" @click="confirm('cancel')">{{ billing.status === 'trialing' ? '取消试用后的续费' : '取消自动续费' }}</button>
        <button v-if="billing?.status === 'canceling'" class="membership-primary w-full" :disabled="busy" @click="confirm('reactivate')">恢复自动续费</button>
        <a v-if="billing && billing.status !== 'none'" :href="billing.portalUrl" target="_blank" rel="noopener noreferrer" class="membership-secondary w-full">{{ billing.status === 'past_due' ? '更新付款方式' : '账单与付款方式' }}<ArrowUpRight :size="14" /></a>
        <router-link to="/pricing" class="block text-center text-xs text-[var(--ink-soft)] hover:text-[var(--ink)] transition-colors">查看详细功能、定价与退款规则 &rarr;</router-link>
      </div>
    </section>
    <section id="credits" aria-labelledby="rewards-heading" class="clay clay-glass overflow-hidden">
      <div class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3"><Sparkles :size="16" class="text-[var(--premium-gold)]" /><h2 id="rewards-heading" class="font-display text-sm font-bold">星月积分</h2></div>
      <div class="p-5 space-y-4">
        <div>
          <p class="text-xs text-[var(--ink-soft)]">可用余额</p>
          <p class="font-display text-3xl font-bold mt-1">{{ auth.pointsBalance.toLocaleString() }}</p>
          <p v-if="sub?.legacyComputeAccess" class="mt-2 text-xs text-[var(--ink-soft)]">现有会员有效期内，继续按原约定使用 AI。</p>
        </div>
        <dl v-if="auth.currency?.compute" class="space-y-2 text-xs">
          <div v-if="auth.currency.compute.welcomeExpiresAt" class="flex justify-between gap-2"><dt>试用 · {{ date(auth.currency.compute.welcomeExpiresAt) }} 到期</dt><dd>{{ auth.currency.compute.welcome }}</dd></div>
          <div v-if="auth.currency.compute.weeklyResetsAt" class="flex justify-between gap-2"><dt>周额度 · {{ date(auth.currency.compute.weeklyResetsAt) }} 到期</dt><dd>{{ auth.currency.compute.weekly }}</dd></div>
          <div class="flex justify-between gap-2"><dt>充值积分</dt><dd>{{ auth.currency.compute.purchased }}</dd></div>
        </dl>
        <div v-if="auth.currency?.compute?.topUpEnabled" class="space-y-3">
          <fieldset class="flex flex-wrap gap-2" :disabled="busy">
            <legend class="mb-2 text-sm font-semibold">选择充值额度</legend>
            <button v-for="points in [1500, 2500, 5000]" :key="points" type="button" class="membership-secondary" :aria-pressed="topUpPoints === points" @click="topUpPoints = points">{{ points.toLocaleString() }}</button>
          </fieldset>
          <label class="flex items-center justify-between gap-3 text-sm">
            自选积分
            <input v-model.number="topUpPoints" type="number" class="w-28 rounded-lg border border-[var(--line)] px-2 py-1" :min="CREDIT_TOP_UP.minimum" :max="CREDIT_TOP_UP.maximum" :step="CREDIT_TOP_UP.step" :disabled="busy" />
          </label>
          <button class="membership-primary w-full" :disabled="busy || !topUpPrice" @click="topUp">一次性支付 US${{ topUpPrice ?? '—' }}</button>
          <p class="text-xs text-[var(--ink-soft)]">充值积分可跨周使用。税费以收银台为准。</p>
        </div>
        <p v-else class="text-xs text-[var(--ink-soft)]">充值暂未开放</p>
        <div v-if="(auth.currency?.balance ?? 0) > 0" class="border-t border-[var(--line)] pt-3 space-y-2">
          <p class="text-xs text-[var(--ink-soft)]">历史奖励积分 {{ auth.currency?.balance.toLocaleString() }}</p>
          <button v-if="(auth.currency?.balance ?? 0) >= 2000" class="membership-secondary w-full" :disabled="busy" @click="confirm('reward')">兑换 30 天奖励会员</button>
        </div>
      </div>
    </section>
    <dialog ref="dialog" class="membership-dialog clay p-6" @cancel="busy && $event.preventDefault()">
      <h2 class="font-display text-lg font-bold">{{ confirmTitle }}</h2><p class="mt-3 text-sm leading-6 text-[var(--ink-soft)]">{{ confirmDetail }}</p>
      <div class="flex gap-3 mt-6"><button autofocus class="membership-secondary flex-1" :disabled="busy" @click="dialog?.close()">返回</button><button class="membership-primary flex-1" :disabled="busy" @click="execute">{{ busy ? '正在处理…' : confirmTitle }}</button></div>
    </dialog>
  </div>
</template>

<style scoped>
.membership-panel { color: var(--ink); }
.status-pill { border-radius: 999px; background: var(--premium-gold-soft); color: var(--ink-soft); padding: 5px 10px; font-size: 12px; font-weight: 600; }
.membership-primary, .membership-secondary { display: inline-flex; align-items: center; justify-content: center; gap: 7px; border-radius: 16px; padding: 11px 14px; font-family: var(--font-display); font-size: 13px; font-weight: 700; transition: transform .2s; }
.membership-primary { background: linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%); color: white; box-shadow: 0 6px 18px -4px var(--accent-glow); }
.membership-secondary { border: 1px solid var(--line); color: var(--ink-soft); background: var(--paper); }
button:disabled { opacity: .5; cursor: not-allowed; }
button:not(:disabled):active { transform: scale(.98); }
button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.membership-dialog { width: min(400px,calc(100vw - 32px)); margin: auto; color: var(--ink); border: 1px solid var(--line); background: var(--paper); }
.membership-dialog::backdrop { background: rgba(40,35,28,.25); backdrop-filter: blur(5px); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>
