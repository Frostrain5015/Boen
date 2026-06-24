<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import type { Grade } from '@boen/shared';
import { ArrowLeft, User, GraduationCap, Sparkles, Type, Mail, Moon, Star, Lock } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/services/auth';
import { useToast } from '@/composables/useToast';
import MembershipCard from '@/components/MembershipCard.vue';

const router = useRouter();
const authStore = useAuthStore();
const toast = useToast();

const isFirstSetup = computed(() => !authStore.userProfile);
const redeemedTier = ref<'monthly' | 'yearly'>('monthly');

// ── 星月卡兑换 ──
const redeemInput = ref('');
const redeeming = ref(false);

// ── 兑换成功动画（同一卡面 DOM 原地完成整个链路，不重建）──
// 原位 → 放大移到中央 → 镜面闪光 → 停留展示"我知道了" → 缩小飞回原位 → 镜面闪光 → 常驻
const animActive = ref(false);          // 控制遮罩/抬升层的挂载
const overlayVisible = ref(false);      // 暗色遮罩淡入淡出
const showCenterUI = ref(false);        // 中央文案 + "我知道了"
const animPhase = ref<'init' | 'enter' | 'leave'>('init'); // init=无过渡定位起点
const cardTransform = ref('translate(0px, 0px) scale(1)');
const animCardRef = ref<HTMLDivElement | null>(null);
const premiumCardRef = ref<InstanceType<typeof MembershipCard> | null>(null);
const adYearlyRef = ref<InstanceType<typeof MembershipCard> | null>(null);
const adMonthlyRef = ref<InstanceType<typeof MembershipCard> | null>(null);
// 动画期间覆盖已购卡的显示档位（升级时先维持旧卡、闪光时再切新卡）
const displayTierOverride = ref<'monthly' | 'yearly' | null>(null);
const animWasPremium = ref(false);
const animOldTier = ref<'monthly' | 'yearly'>('monthly');

const ownedCardTier = computed<'monthly' | 'yearly'>(() =>
  displayTierOverride.value ?? (authStore.subscription?.tier === 'yearly' ? 'yearly' : 'monthly'),
);

const redeemHeadline = computed(() => {
  const cardName = redeemedTier.value === 'yearly' ? '星耀卡' : '皓月卡';
  if (!animWasPremium.value) return `您的${cardName}已激活`;
  if (animOldTier.value === 'monthly' && redeemedTier.value === 'yearly') return '您的星耀卡已激活';
  return `您的${cardName}已续期`;
});

onMounted(() => { authStore.fetchCurrencyStatus(); });

// ── 二级确认弹窗 ─────────────────────────────
const confirmState = ref<{ title: string; message: string; notice?: string; onConfirm: () => Promise<void> } | null>(null);
const confirmLoading = ref(false);

function showConfirm(title: string, message: string, onConfirm: () => Promise<void>, notice?: string) {
  confirmState.value = { title, message, notice, onConfirm };
}
function closeConfirm() { confirmState.value = null; }

/** Crockford Base32 解码兑换码中的有效期天数（30/365），仅需前 4 字符即可。 */
function decodeCodeDuration(rawCode: string): number | null {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const norm = rawCode.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (norm.length < 4) return null;
  let bits = 0;
  for (let i = 0; i < 4; i++) {
    const v = ALPHABET.indexOf(norm[i]);
    if (v < 0) return null;
    bits = (bits << 5) | v;
  }
  const durationBit = ((bits >> 4) >> 9) & 1;
  return durationBit === 1 ? 365 : 30;
}

/** 格式化日期 */
function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/** 计算兑换后的到期时间戳（秒），用于确认弹窗 */
function calcExpiry(days: number): number {
  if (authStore.isPremium && authStore.subscription?.expiresAt) {
    const base = Math.max(authStore.subscription.expiresAt, Math.floor(Date.now() / 1000));
    return base + days * 86400;
  }
  return Math.floor(Date.now() / 1000) + days * 86400;
}

const pointsLoading = ref(false);
const freeClaimLoading = ref(false);

/** 用星月积分兑换皓月卡（限时折扣价 1500，复用发卡动画） */
async function handlePointsRedeem() {
  if (pointsLoading.value || redeeming.value) return;
  const tierName = '皓月卡';
  const until = calcExpiry(30);
  showConfirm(
    `确定要激活你的${tierName}吗？`,
    `有效期至 ${fmtDate(until)}`,
    async () => {
      pointsLoading.value = true;
      try {
        const wasPremium = authStore.isPremium;
        const oldTier: 'monthly' | 'yearly' = authStore.subscription?.tier === 'yearly' ? 'yearly' : 'monthly';
        const rect = wasPremium ? null : (adMonthlyRef.value?.rootEl?.getBoundingClientRect() ?? null);
        const r = await authStore.redeemMembershipWithPoints('month_promo');
        if (r.ok) {
          redeemedTier.value = authStore.subscription?.tier === 'yearly' ? 'yearly' : 'monthly';
          closeConfirm();
          await startRedeemAnimation({ wasPremium, oldTier, srcRect: rect });
        } else {
          toast.error(r.message ?? '兑换失败');
          closeConfirm();
        }
      } finally { pointsLoading.value = false; }
    },
  );
}

/** 新用户免费领取皓月卡（从卡片当前位置起飞动画） */
async function handleFreeClaim() {
  if (freeClaimLoading.value || redeeming.value) return;
  const until = calcExpiry(30);
  showConfirm(
    '确定要激活你的皓月卡吗？',
    `有效期至 ${fmtDate(until)}`,
    async () => {
      freeClaimLoading.value = true;
      const token = getToken();
      try {
        const res = await fetch('/api/currency/claim-free-card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        const data = await res.json();
        if (res.ok) {
          await authStore.fetchSubscription();
          redeemedTier.value = 'monthly';
          closeConfirm();
          const rect = adMonthlyRef.value?.rootEl?.getBoundingClientRect() ?? null;
          await startRedeemAnimation({ wasPremium: false, oldTier: 'monthly', srcRect: rect });
        } else {
          toast.error(data.message ?? '领取失败');
          closeConfirm();
        }
      } catch {
        toast.error('领取失败，请稍后再试');
        closeConfirm();
      } finally { freeClaimLoading.value = false; }
    },
    '仅限一次，激活后不可退换',
  );
}

/** 兑换码：先解码得天数再确认 */
async function handleRedeem() {
  const code = redeemInput.value.trim();
  if (!code || redeeming.value) return;
  const days = decodeCodeDuration(code);
  if (!days) {
    toast.error('兑换码无效');
    return;
  }
  const tierName = days >= 365 ? '星耀卡' : '皓月卡';
  const until = calcExpiry(days);
  showConfirm(
    `确定要激活你的${tierName}吗？`,
    `有效期至 ${fmtDate(until)}`,
    async () => {
      redeeming.value = true;
      const wasPremium = authStore.isPremium;
      const oldTier: 'monthly' | 'yearly' = authStore.subscription?.tier === 'yearly' ? 'yearly' : 'monthly';
      const adYearlyRect = wasPremium ? null : (adYearlyRef.value?.rootEl?.getBoundingClientRect() ?? null);
      const adMonthlyRect = wasPremium ? null : (adMonthlyRef.value?.rootEl?.getBoundingClientRect() ?? null);
      try {
        const r = await authStore.redeemCode(code);
        if (r.ok) {
          redeemedTier.value = authStore.subscription?.tier === 'yearly' ? 'yearly' : 'monthly';
          redeemInput.value = '';
          closeConfirm();
          const srcRect = wasPremium ? null : (redeemedTier.value === 'yearly' ? adYearlyRect : adMonthlyRect);
          await startRedeemAnimation({ wasPremium, oldTier, srcRect });
        } else {
          toast.error(r.message ?? '兑换失败');
          closeConfirm();
        }
      } finally { redeeming.value = false; }
    },
  );
}

/** 起点 → 放大移到中央 → 镜面闪光（升级时切档）→ 停留 */
async function startRedeemAnimation(opts: {
  wasPremium: boolean;
  oldTier: 'monthly' | 'yearly';
  srcRect: DOMRect | null;
}) {
  animWasPremium.value = opts.wasPremium;
  animOldTier.value = opts.oldTier;
  // 起始外观：升级时先维持旧卡，待中央闪光时再变新卡；首开/续期直接显示目标卡
  displayTierOverride.value = opts.wasPremium ? opts.oldTier : redeemedTier.value;
  animPhase.value = 'init';
  showCenterUI.value = false;
  cardTransform.value = 'translate(0px, 0px) scale(1)';
  // 续期/升级：用户在卡片背面输入，先把已购卡翻回正面再起飞
  if (opts.wasPremium && premiumCardRef.value?.isFlipped) {
    premiumCardRef.value.flip();
    await new Promise((resolve) => setTimeout(resolve, 480));
  }
  animActive.value = true; // 抬升卡面层 + 挂载遮罩（透明）
  // 等待左侧切换为已购卡面后再测量其原位（即飞回的归宿）
  await nextTick();
  const el = animCardRef.value;
  if (!el) {
    animActive.value = false;
    displayTierOverride.value = null;
    return;
  }
  const rect = el.getBoundingClientRect();
  const restCx = rect.left + rect.width / 2;
  const restCy = rect.top + rect.height / 2;
  const centerTransform = `translate(${window.innerWidth / 2 - restCx}px, ${window.innerHeight / 2 - 56 - restCy}px) scale(1.28)`;
  // 起点：首开从被兑换的广告卡位置起飞；续期/升级从已购卡原位起飞
  if (opts.srcRect) {
    const srcDx = opts.srcRect.left + opts.srcRect.width / 2 - restCx;
    const srcDy = opts.srcRect.top + opts.srcRect.height / 2 - restCy;
    cardTransform.value = `translate(${srcDx}px, ${srcDy}px) scale(1)`; // phase=init，无过渡，瞬间定位
  }
  overlayVisible.value = true; // 遮罩淡入
  // 待起点帧绘制后再开过渡飞向中央
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      animPhase.value = 'enter';
      cardTransform.value = centerTransform;
    });
  });
  // 抵达中央：镜面闪光 +（升级时）切换卡档 + 浮现文案
  window.setTimeout(() => {
    displayTierOverride.value = redeemedTier.value;
    premiumCardRef.value?.playShimmer();
    showCenterUI.value = true;
  }, 660);
}

/** 缩小飞回原位 → 镜面闪光 → 常驻 */
function handleRedeemDismiss() {
  animPhase.value = 'leave';
  showCenterUI.value = false;
  cardTransform.value = 'translate(0px, 0px) scale(1)';
  // 落回原位后：再次镜面闪光 + 遮罩淡出
  window.setTimeout(() => {
    premiumCardRef.value?.playShimmer();
    overlayVisible.value = false;
    // 遮罩淡出结束后撤掉抬升层，卡面常驻原位（恢复跟随 store 档位）
    window.setTimeout(() => {
      animActive.value = false;
      displayTierOverride.value = null;
    }, 360);
  }, 620);
}

// ── 设置 ──
const GRADE_GROUPS: { band: string; items: { value: Grade; label: string }[] }[] = [
  { band: '小学', items: ['一', '二', '三', '四', '五', '六'].map((c, i) => ({ value: String(i + 1) as Grade, label: `${c}年级` })) },
  { band: '初中', items: ['一', '二', '三'].map((c, i) => ({ value: String(i + 7) as Grade, label: `初${c}` })) },
  { band: '其他', items: [{ value: 'high', label: '高中' }, { value: 'college', label: '大学及以上' }] },
];

function detectBand(g: Grade): string {
  for (const group of GRADE_GROUPS) {
    if (group.items.some(i => i.value === g)) return group.band;
  }
  return '初中';
}

const name = ref(authStore.userProfile?.name ?? '');
const grade = ref<Grade>(authStore.userProfile?.grade ?? '8');
const selectedBand = ref(detectBand(grade.value));
const modelProvider = ref(localStorage.getItem('boen_model_provider') || 'default');
const fontSize = ref<'sm' | 'md' | 'lg'>(
  (localStorage.getItem('boen_font_size') as 'sm' | 'md' | 'lg') || 'md',
);

const currentBandItems = computed(() =>
  GRADE_GROUPS.find(g => g.band === selectedBand.value)?.items ?? [],
);

const FONT_SIZE_OPTIONS = [
  { value: 'sm' as const, label: '小', px: '14px' },
  { value: 'md' as const, label: '中', px: '16px' },
  { value: 'lg' as const, label: '大', px: '18px' },
];

/** 自动保存所有设置到 localStorage + 后端 */
function autoSave() {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  localStorage.setItem('boen_model_provider', modelProvider.value);
  localStorage.setItem('boen_font_size', fontSize.value);
  authStore.saveProfile({ name: trimmed, grade: grade.value });
  fetch('/api/model/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: modelProvider.value }),
  }).catch(() => {});
}

/** 选择模型：非星月卡点 DS 弹窗，否则立即切换+保存 */
function setProvider(val: string) {
  if (val !== 'default' && !authStore.isPremium) {
    toast.info('该功能为星月卡专属');
    return;
  }
  modelProvider.value = val;
  autoSave();
}

/** 名称失焦时自动保存 */
function onNameBlur() {
  if (name.value.trim()) autoSave();
}

/** 年级点击时自动保存 */
function setGrade(g: Grade) {
  grade.value = g;
  autoSave();
}

// 字体大小实时预览 + 保存
watch(fontSize, (val) => {
  localStorage.setItem('boen_font_size', val);
  document.documentElement.setAttribute('data-fontsize', val);
  autoSave();
}, { immediate: true });

function handleBack() {
  if (!isFirstSetup.value) router.push('/');
}
</script>

<template>
  <div class="flex min-h-full flex-col p-6 pt-8">
    <!-- 头部 -->
    <div class="mb-6 flex items-center gap-3">
      <button
        v-if="!isFirstSetup"
        @click="handleBack"
        class="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[var(--line)]/50"
      >
        <ArrowLeft class="h-5 w-5" style="color: var(--ink-soft)" />
      </button>
      <div>
        <h1 class="font-display text-xl font-bold" style="color: var(--ink)">
          {{ isFirstSetup ? '初始设置' : '个人中心' }}
        </h1>
        <p class="text-sm" style="color: var(--ink-soft)">
          {{ isFirstSetup ? '让我们先认识一下你' : '个性化你的学习体验' }}
        </p>
      </div>
    </div>

    <!-- 主体：左右布局 -->
    <div class="flex flex-1 gap-6 max-w-[900px] w-full mx-auto">

      <!-- ═══ 左侧：星月卡区域 ═══ -->
      <div class="flex w-[380px] shrink-0 flex-col gap-4">
        <!-- 已有星月卡：展示卡面 + 续费 -->
        <template v-if="authStore.isPremium">
          <div
            ref="animCardRef"
            class="anim-card-wrapper"
            :class="[{ 'is-animating': animActive }, animActive ? `phase-${animPhase}` : '']"
            :style="animActive ? { transform: cardTransform } : undefined"
          >
            <MembershipCard
              ref="premiumCardRef"
              :type="ownedCardTier"
              :expires-at="authStore.subscription?.expiresAt"
              :holder-name="authStore.userProfile?.name || authStore.currentUser?.username || ''"
              :show-price="false"
              size="md"
              redeemable
              v-model:redeem-code="redeemInput"
              :redeeming="redeeming"
              redeem-placeholder="兑换码续期 / 升级"
              :points-balance="authStore.pointsBalance"
              :points-redeeming="pointsLoading"
              @redeem="handleRedeem"
              @redeem-points="handlePointsRedeem"
            />
          </div>
          <p class="text-xs text-center" style="color: var(--ink-soft)">
            <Sparkles class="inline h-3 w-3 mr-1" style="color: var(--premium-gold)" />
            点击卡片翻面，在背面输入兑换码续期或升级
          </p>
        </template>

        <!-- 无星月卡：广告展示（上下叠放） -->
        <template v-else>
          <div class="flex flex-col items-center gap-3">
            <MembershipCard
              ref="adYearlyRef"
              type="yearly"
              size="md"
              :show-price="true"
              locked
              redeemable
              v-model:redeem-code="redeemInput"
              :redeeming="redeeming"
              redeem-placeholder="输入兑换码激活"
              @redeem="handleRedeem"
            />
            <MembershipCard
              ref="adMonthlyRef"
              type="monthly"
              size="md"
              :show-price="true"
              locked
              :claimable="!authStore.isPremium && !authStore.subscription?.activatedAt"
              redeemable
              v-model:redeem-code="redeemInput"
              :redeeming="redeeming"
              redeem-placeholder="输入兑换码激活"
              :points-balance="authStore.pointsBalance"
              :points-redeeming="pointsLoading"
              @redeem="handleRedeem"
              @redeem-points="handlePointsRedeem"
              @claim-free="handleFreeClaim"
            />
          </div>
          <p class="text-xs text-center" style="color: var(--ink-soft)">
            <Sparkles class="inline h-3 w-3 mr-1" style="color: var(--premium-gold)" />
            点击卡片翻面，可用兑换码或积分激活
          </p>
        </template>

        <!-- ═══ 限时活动：积分折扣兑换皓月卡 ═══ -->
        <div class="clay clay-glass overflow-hidden" style="border: 1px solid var(--premium-gold)">
          <div class="flex items-center gap-2 px-4 py-2.5" style="background: var(--premium-gold-soft)">
            <span class="rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style="background: var(--premium-gold)">限时活动</span>
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">星月积分兑换皓月卡</h2>
          </div>
          <div class="space-y-3 px-4 py-3">
            <!-- 限时折扣兑换 -->
            <div class="rounded-2xl px-4 py-3" style="background: var(--premium-gold-soft)">
              <div class="mb-1 flex items-center justify-between">
                <span class="font-display text-sm font-bold text-[var(--ink)]">限时折扣</span>
                <span class="text-[10px] text-[var(--ink-soft)]">至 2026-07-31</span>
              </div>
              <div class="flex items-center justify-center gap-2 rounded-xl py-2 font-display text-base font-bold"
                style="color: var(--premium-gold)">
                <span><Sparkles class="inline h-4 w-4" /><s class="mx-1">2000</s> 1500 兑换 🌙皓月卡</span>
              </div>
              <div class="mt-2 h-2 overflow-hidden rounded-full" style="background: var(--line)">
                <div class="h-full rounded-full transition-all duration-500"
                  :style="{ width: Math.min(100, (authStore.pointsBalance / 1500) * 100) + '%', background: 'var(--premium-gold)' }"></div>
              </div>
              <div class="mt-1 flex items-center justify-between text-[11px]">
                <span class="text-[var(--ink-soft)]">今日已赚 {{ authStore.currency?.todayEarned ?? 0 }} / {{ authStore.currency?.dailyCap ?? 100 }}</span>
                <div class="flex items-center gap-2">
                  <span class="font-display font-bold" :style="{ color: authStore.pointsBalance >= 1500 ? 'var(--success)' : 'var(--premium-gold)' }">
                    {{ authStore.pointsBalance }} / 1500
                  </span>
                  <button @click="handlePointsRedeem"
                    :disabled="authStore.pointsBalance < 1500 || pointsLoading"
                    class="rounded-lg px-3 py-1 text-[11px] font-bold text-white transition-all active:scale-[0.95] disabled:opacity-40"
                    style="background: var(--premium-gold)">
                    {{ pointsLoading ? '兑换中' : '兑换' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ═══ 二级确认弹窗 ═══ -->
      <Teleport to="body">
        <Transition name="confirm-fade">
          <div v-if="confirmState" class="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 backdrop-blur-sm" @click.self="closeConfirm">
            <div class="clay clay-glass mx-4 w-full max-w-sm overflow-hidden text-center">
              <div class="px-6 pt-6 pb-4">
                <p class="mb-3 font-display text-base font-bold text-[var(--ink)]">{{ confirmState.title }}</p>
                <p class="mb-1 text-sm text-[var(--ink-soft)]">{{ confirmState.message }}</p>
                <p v-if="confirmState.notice" class="text-[11px] leading-tight" style="color: var(--error)">{{ confirmState.notice }}</p>
              </div>
              <div class="flex gap-3 border-t border-[var(--line)] px-6 py-4">
                <button @click="closeConfirm" class="flex-1 rounded-2xl border border-[var(--line)] bg-white py-2.5 font-display text-sm font-bold text-[var(--ink-soft)] transition-all hover:border-[var(--accent)] active:scale-[0.97]">取消</button>
                <button @click="confirmLoading ? null : (confirmLoading=true, confirmState.onConfirm().finally(() => confirmLoading=false))"
                  class="flex-1 rounded-2xl py-2.5 font-display text-sm font-bold text-white transition-all active:scale-[0.97]"
                  :style="{ background: 'linear-gradient(180deg, var(--premium-gold), var(--premium-gold-strong))' }"
                >{{ confirmLoading ? '处理中…' : '确定' }}</button>
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>

      <!-- ═══ 右侧：设置列表 ═══ -->
      <div class="flex-1 min-w-0 space-y-4">
        <!-- 个人信息 -->
        <div class="clay clay-glass overflow-hidden">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3">
            <User class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">个人信息</h2>
          </div>
          <div class="space-y-4 px-5 py-4">
            <!-- 头像 + 账号 -->
            <div class="flex items-center gap-3">
              <div class="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--accent-soft)]">
                <img
                  v-if="authStore.currentUser?.picture"
                  :src="authStore.currentUser.picture"
                  :alt="authStore.currentUser.username"
                  class="h-full w-full object-cover"
                />
                <User v-else class="h-5 w-5 text-[var(--accent-strong)]" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-bold text-[var(--ink)]">{{ authStore.currentUser?.username ?? '用户' }}</p>
                <div class="flex items-center gap-1.5 text-xs text-[var(--ink-soft)]">
                  <Mail class="h-3 w-3" />
                  {{ authStore.currentUser?.email ?? '' }}
                </div>
              </div>
            </div>
            <!-- 名字 -->
            <label class="flex flex-col gap-1.5">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
                <User class="h-3.5 w-3.5" /> 你的名字
              </span>
              <input v-model="name" @blur="onNameBlur" placeholder="输入你的名字或昵称…" maxlength="20"
                class="w-full rounded-xl border bg-white px-3 py-2.5 text-sm outline-none transition-colors"
                style="border-color: var(--line); color: var(--ink)"
                @focus="($event.target as HTMLElement).style.borderColor = 'var(--accent)'"
              />
            </label>
          </div>
        </div>

        <!-- 学习配置 -->
        <div class="clay clay-glass overflow-hidden">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3">
            <GraduationCap class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">学习配置</h2>
          </div>
          <div class="space-y-4 px-5 py-4">
            <div class="flex flex-col gap-3">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
                <GraduationCap class="h-3.5 w-3.5" /> 当前年级
              </span>
              <!-- 第一行：学段 -->
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="group in GRADE_GROUPS"
                  :key="group.band"
                  @click="selectedBand = group.band"
                  class="flex h-10 items-center justify-center rounded-2xl border-2 text-xs font-bold transition-all active:scale-[0.97]"
                  :class="selectedBand === group.band
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                    : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'"
                >{{ group.band }}</button>
              </div>
              <!-- 第二行：具体年级 -->
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="item in currentBandItems"
                  :key="item.value"
                  @click="setGrade(item.value)"
                  class="flex h-9 items-center justify-center rounded-xl px-3.5 text-xs font-bold transition-all active:scale-[0.97]"
                  :class="grade === item.value
                    ? 'bg-[var(--accent)] text-white shadow-sm'
                    : 'bg-[var(--paper)] text-[var(--ink-soft)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent-strong)]'"
                >{{ item.label }}</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 应用偏好 -->
        <div class="clay clay-glass overflow-hidden">
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3">
            <Sparkles class="h-4 w-4 text-[var(--accent)]" />
            <h2 class="font-display text-sm font-bold text-[var(--ink)]">应用偏好</h2>
          </div>
          <div class="space-y-5 px-5 py-4">
            <!-- 对话模型 -->
            <div class="flex flex-col gap-2">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
                <Sparkles class="h-3.5 w-3.5" /> 对话模型
              </span>
              <div class="flex flex-wrap gap-2">
                <button @click="setProvider('default')"
                  class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97] min-w-[130px]"
                  :class="(modelProvider === 'default' || modelProvider === 'deepseek') ? 'border-[#4A6CF7] bg-[#e8edff] text-[#2b4ad0]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[#4A6CF7]'"
                ><span>DeepSeek V4 Flash</span></button>
                <button @click="setProvider('deepseek-pro')"
                  class="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border-2 py-2.5 font-display text-sm font-bold transition-all active:scale-[0.97] min-w-[130px]"
                  :class="(modelProvider === 'deepseek-pro' ? 'border-[#E8A317] bg-[#fef3d2] text-[#b8730d]' : 'border-[var(--line)] bg-white text-[var(--ink-soft)]') + (authStore.subscription?.tier !== 'yearly' ? ' opacity-40 cursor-not-allowed' : ' hover:border-[#E8A317]')"
                  :disabled="authStore.subscription?.tier !== 'yearly'"
                ><span v-if="authStore.subscription?.tier !== 'yearly'"><Lock class="inline h-3 w-3 mr-0.5" /></span>DeepSeek V4 Pro</button>
              </div>
            </div>

            <!-- 字体大小 -->
            <div class="flex flex-col gap-2">
              <span class="flex items-center gap-1.5 font-display text-xs font-semibold" style="color: var(--ink-soft)">
                <Type class="h-3.5 w-3.5" /> 字体大小
              </span>
              <div class="grid grid-cols-3 gap-2">
                <button
                  v-for="opt in FONT_SIZE_OPTIONS"
                  :key="opt.value"
                  @click="fontSize = opt.value"
                  class="flex flex-col items-center gap-1 rounded-2xl border-2 py-3 transition-all active:scale-[0.97]"
                  :class="fontSize === opt.value
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-strong)]'
                    : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent)]'"
                >
                  <span class="font-display font-bold" :style="{ fontSize: opt.px }">{{ opt.label }}</span>
                  <span class="text-[10px] opacity-60">{{ opt.px }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="pb-8"></div>
      </div>
    </div>

    <!-- 兑换成功动画：暗色遮罩 + 中央文案（卡面本身在左侧原地放大移入，见 anim-card-wrapper） -->
    <div v-if="animActive" class="redeem-overlay" :class="{ visible: overlayVisible }" />
    <div v-if="animActive" class="redeem-center-ui" :class="{ visible: showCenterUI }">
      <div class="redeem-text" :style="{ color: redeemedTier === 'yearly' ? '#e7d8f2' : '#e3e9ee' }">
        <Sparkles class="redeem-icon" />
        <span>{{ redeemHeadline }}</span>
      </div>
      <button @click="handleRedeemDismiss" class="redeem-dismiss-btn">我知道了</button>
    </div>
  </div>
</template>

<style scoped>
/* ── 兑换成功动画 ── */
/* 抬升层：让左侧同一卡面盖在暗色遮罩之上，原地用 transform 移动/缩放，不重建 DOM */
.anim-card-wrapper {
  display: flex;
  justify-content: center;
}
.anim-card-wrapper.is-animating {
  position: relative;
  z-index: 1001;
  will-change: transform;
}
.anim-card-wrapper.phase-init {
  transition: none; /* 瞬间把卡面定位到起飞点，不产生过渡 */
}
.anim-card-wrapper.phase-enter {
  transition: transform 0.62s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.anim-card-wrapper.phase-leave {
  transition: transform 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 暗色半透明遮罩，淡入淡出 */
.redeem-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(18, 16, 22, 0.55);
  backdrop-filter: blur(6px);
  opacity: 0;
  transition: opacity 0.36s ease;
}
.redeem-overlay.visible {
  opacity: 1;
}

/* 中央文案 + 按钮（位于卡面下方） */
.redeem-center-ui {
  position: fixed;
  left: 50%;
  top: calc(50% + 150px);
  z-index: 1002;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  transform: translate(-50%, 8px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.redeem-center-ui.visible {
  opacity: 1;
  transform: translate(-50%, 0);
  pointer-events: auto;
}

.redeem-text {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 1.125rem;
  font-weight: 700;
  color: #e7e2ea;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.4);
}

.redeem-icon {
  width: 20px;
  height: 20px;
}

.redeem-dismiss-btn {
  padding: 10px 40px;
  border-radius: 99px;
  font-family: var(--font-display);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.redeem-dismiss-btn:hover {
  border-color: var(--premium-gold);
  box-shadow: 0 4px 12px -4px var(--premium-gold-glow);
}

/* ── 二级确认弹窗淡入淡出 ── */
:global(.confirm-fade-enter-active) { transition: opacity 0.22s ease; }
:global(.confirm-fade-leave-active) { transition: opacity 0.15s ease; }
:global(.confirm-fade-enter-from) { opacity: 0; }
:global(.confirm-fade-leave-to) { opacity: 0; }
</style>
