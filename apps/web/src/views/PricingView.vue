<script setup lang="ts">
import { computed, ref } from 'vue';
import { MEMBERSHIP_PLANS, type MembershipPlanKey } from '@boen/shared';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Sparkles,
  ShieldCheck,
  Zap,
  HelpCircle,
  Layers,
  ChevronDown,
} from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const activeVisTier = ref<MembershipPlanKey>('plus');

const manageMembership = computed(() =>
  Boolean(auth.authenticated && auth.subscription?.billing.checkoutAllowed === false),
);

function getActionLabel(planName: string): string {
  if (manageMembership.value) return '管理当前订阅';
  if (!auth.authenticated) return `登录后订阅${planName}`;
  return `订阅${planName}`;
}

const openFaqIndex = ref<number | null>(0);
function toggleFaq(index: number) {
  openFaqIndex.value = openFaqIndex.value === index ? null : index;
}

const faqs = [
  {
    q: '每周未用完的算力积分会清空吗？',
    a: '星月卡会员包含的每周定额算力会在每周一北京时间零点自动刷新重置，当周未使用的会员额度会清零。若您单独购买了“备用加油包”充值积分，该充值积分不受周刷新限制，支持跨周永久有效直至用尽。',
  },
  {
    q: '算力耗尽后，我还能查看以前的错题和学习记录吗？',
    a: '完全可以。博文明确承诺保障您的基础数据资产：无论您是否订阅会员、当前算力是否耗尽，您已记录的错题本、历史试卷深度解析、知识画像均永久免费向您开放，绝不设限或锁定。积分仅在调用云端 AI 触发实时推理与新题生成时扣除。',
  },
  {
    q: '如何取消自动续费？退款规则是怎样的？',
    a: '在「个人中心 → 会员与订阅 → 取消自动续费」即可随时一键在线取消，无需人工审核。取消后当前周期的全部权益将继续保留直至周期自然结束。若发生系统重复扣款或重大技术故障导致无法使用，请在 14 天内联系支持邮箱申请原路退款。',
  },
  {
    q: '未成年人使用有何特别规定？',
    a: '未满 14 周岁学生须经监护人同意并在其指导下使用；未满 18 周岁购买付费服务须取得监护人明确同意。监护人如发现未成年人未经允许产生消费，可随时联系支持邮箱核实退款。',
  },
];
</script>

<template>
  <div class="relative h-full overflow-y-auto text-[var(--ink)] bg-[var(--paper)]">
    <div class="app-bg" aria-hidden="true" />
    <div class="app-grain" aria-hidden="true" />

    <main class="relative z-10 mx-auto max-w-5xl px-5 py-8 sm:px-8 sm:py-12 space-y-16">
      <!-- 顶部导航 -->
      <nav class="flex items-center justify-between gap-4 text-sm border-b border-[var(--line)] pb-4">
        <router-link to="/" class="inline-flex items-center gap-1.5 text-[var(--ink-soft)] hover:text-[var(--ink)] font-semibold transition-colors">
          <ArrowLeft :size="16" />
          返回博文
        </router-link>
        <div class="flex items-center gap-2">
          <span class="brand-text font-bold text-base">博文 Boen</span>
          <span class="text-xs px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)] font-semibold">会员体系 2.0</span>
        </div>
      </nav>

      <!-- 头部 Hero 区域 -->
      <section class="text-center space-y-4 max-w-2xl mx-auto pt-2">
        <div class="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)] text-xs font-bold tracking-wide">
          <Sparkles :size="14" />
          <span>新用户首次进入赠送 500 点算力</span>
          <span class="opacity-30">|</span>
          <span>14 天有效</span>
        </div>
        <h1 class="font-display text-3xl sm:text-5xl font-black tracking-tight leading-tight">
          透明算力，伴随每一次专注成长
        </h1>
        <p class="text-sm sm:text-base text-[var(--ink-soft)] leading-relaxed">
          从日常拍照答疑到全题型仿真模考，精准扣点，用多少算多少。每一分钱都实打实落在云端 AI 推理上。
        </p>
      </section>

      <!-- 核心方案双旗舰卡牌并列（Side-by-Side Dual Tier Showcase） -->
      <section class="grid grid-cols-1 md:grid-cols-2 gap-8 items-stretch max-w-4xl mx-auto">
        
        <!-- 皓月卡（白金银霜 · 亲民高性价比之选） -->
        <article class="clay-tier-card rounded-3xl p-7 flex flex-col justify-between relative transition-all duration-300 hover:translate-y-[-4px]">
          <div class="space-y-6">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-xs font-bold uppercase tracking-wider text-[var(--accent-strong)] bg-[var(--accent-soft)] px-2.5 py-1 rounded-md">
                  日常高效辅导
                </span>
                <h2 class="font-display text-2xl font-black text-[var(--ink)] mt-2">皓月卡</h2>
              </div>
              <div class="w-12 h-12 rounded-2xl bg-[#f0e8dc] flex items-center justify-center font-display text-xl font-black text-[var(--ink-soft)] shadow-inner">
                月
              </div>
            </div>

            <div class="border-y border-[var(--line)] py-4">
              <div class="flex items-baseline gap-1">
                <span class="font-display text-3xl font-black text-[var(--ink)] font-mono">$2.99</span>
                <span class="text-xs font-semibold text-[var(--ink-soft)]">/月</span>
              </div>
              <div class="mt-2 text-xs font-bold text-[var(--accent-strong)] flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
                每周发放 1,000 算力积分（周一重置）
              </div>
            </div>

            <ul class="space-y-3.5 text-xs text-[var(--ink)]">
              <li class="flex items-center gap-2.5">
                <div class="w-4 h-4 rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)] flex items-center justify-center font-bold text-[10px] shrink-0">✓</div>
                <span><strong>DeepSeek Flash</strong> 高速解题大模型</span>
              </li>
              <li class="flex items-center gap-2.5">
                <div class="w-4 h-4 rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)] flex items-center justify-center font-bold text-[10px] shrink-0">✓</div>
                <span>全学科试题拍照答疑、OCR 识别与思路启发</span>
              </li>
              <li class="flex items-center gap-2.5">
                <div class="w-4 h-4 rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)] flex items-center justify-center font-bold text-[10px] shrink-0">✓</div>
                <span>各年级专项考点智能组卷与即时批改</span>
              </li>
              <li class="flex items-center gap-2.5">
                <div class="w-4 h-4 rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)] flex items-center justify-center font-bold text-[10px] shrink-0">✓</div>
                <span>错题智能归因分析与薄弱知识点画像</span>
              </li>
            </ul>
          </div>

          <div class="pt-8 space-y-2.5">
            <router-link
              :to="{ name: 'setup', query: manageMembership ? {} : { plan: 'plus' } }"
              class="tier-btn-primary block w-full py-3.5 px-4 rounded-2xl text-center font-display font-bold text-sm tracking-wide transition-all active:scale-[0.98]"
            >
              {{ getActionLabel('皓月卡') }}
            </router-link>
            <p class="text-center text-[11px] text-[var(--ink-soft)]">连续包月，可随时在个人中心取消续费</p>
          </div>
        </article>

        <!-- 星耀卡（曜黑曜金 · 满血旗舰 Pro · 绝对视觉主角） -->
        <article class="pro-tier-card rounded-3xl p-7 flex flex-col justify-between relative transition-all duration-300 hover:translate-y-[-4px]">
          <!-- 旗舰发光 Badge -->
          <div class="absolute -top-3.5 right-6 px-3.5 py-1 rounded-full bg-gradient-to-r from-amber-500 via-amber-400 to-amber-600 text-slate-950 text-[11px] font-black shadow-lg flex items-center gap-1.5">
            <Zap :size="12" class="fill-current" />
            <span>满血旗舰 · 深度攻坚</span>
          </div>

          <div class="space-y-6">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-xs font-bold uppercase tracking-wider text-amber-400 bg-amber-400/15 px-2.5 py-1 rounded-md border border-amber-400/30">
                  高阶解题与仿真模考
                </span>
                <h2 class="font-display text-2xl font-black text-white mt-2">星耀卡</h2>
              </div>
              <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-400/30 to-amber-600/10 flex items-center justify-center font-display text-xl font-black text-amber-400 border border-amber-400/30 shadow-inner">
                曜
              </div>
            </div>

            <div class="border-y border-white/10 py-4">
              <div class="flex items-baseline gap-1">
                <span class="font-display text-3xl font-black text-amber-400 font-mono gold-glow">$9.99</span>
                <span class="text-xs font-semibold text-slate-400">/月</span>
              </div>
              <div class="mt-2 text-xs font-bold text-amber-300 flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                每周发放 5,000 算力积分（5倍大容量）
              </div>
            </div>

            <ul class="space-y-3.5 text-xs text-slate-200">
              <li class="flex items-center gap-2.5">
                <div class="w-4 h-4 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center font-bold text-[10px] shrink-0">✓</div>
                <span><strong>DeepSeek Pro 满血版</strong> 高阶思维链大模型</span>
              </li>
              <li class="flex items-center gap-2.5">
                <div class="w-4 h-4 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center font-bold text-[10px] shrink-0">✓</div>
                <span>包含皓月卡全部权益，解锁复杂多轮引导对话</span>
              </li>
              <li class="flex items-center gap-2.5">
                <div class="w-4 h-4 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center font-bold text-[10px] shrink-0">✓</div>
                <span>几何综合压轴大题深度分步推导与逻辑自检</span>
              </li>
              <li class="flex items-center gap-2.5">
                <div class="w-4 h-4 rounded-full bg-amber-400 text-slate-950 flex items-center justify-center font-bold text-[10px] shrink-0">✓</div>
                <span>完整全题型期末仿真大考，深度错因精准排查</span>
              </li>
            </ul>
          </div>

          <div class="pt-8 space-y-2.5">
            <router-link
              :to="{ name: 'setup', query: manageMembership ? {} : { plan: 'pro' } }"
              class="tier-btn-gold block w-full py-3.5 px-4 rounded-2xl text-center font-display font-bold text-sm tracking-wide transition-all active:scale-[0.98]"
            >
              {{ getActionLabel('星耀卡') }}
            </router-link>
            <p class="text-center text-[11px] text-slate-400">享有独立高优先级计算队列与满血模型支持</p>
          </div>
        </article>

      </section>

      <!-- 核心亮点：算力透视交互尺（Interactive Usage Visualizer） -->
      <section class="clay-panel rounded-3xl p-6 sm:p-8 space-y-6 max-w-4xl mx-auto">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div>
            <div class="flex items-center gap-2">
              <Layers :size="18" class="text-[var(--accent-strong)]" />
              <h2 class="font-display text-lg font-bold text-[var(--ink)]">算力透视尺：1,000 与 5,000 积分能做多少事？</h2>
            </div>
            <p class="text-xs text-[var(--ink-soft)] mt-1">消除点数黑盒疑虑，用量透明直观</p>
          </div>
          <div class="flex gap-1.5 bg-[#f0e8dc] p-1 rounded-xl text-xs font-bold">
            <button
              class="px-3.5 py-1.5 rounded-lg transition-all"
              :class="activeVisTier === 'plus' ? 'bg-white shadow-xs text-[var(--ink)] font-black' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"
              @click="activeVisTier = 'plus'"
            >
              皓月卡 (1,000分/周)
            </button>
            <button
              class="px-3.5 py-1.5 rounded-lg transition-all"
              :class="activeVisTier === 'pro' ? 'bg-white shadow-xs text-[var(--ink)] font-black' : 'text-[var(--ink-soft)] hover:text-[var(--ink)]'"
              @click="activeVisTier = 'pro'"
            >
              星耀卡 (5,000分/周)
            </button>
          </div>
        </div>

        <!-- 动态透视指标 -->
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div class="p-4 rounded-2xl bg-[#faf6f0] border border-[#eee2d0] space-y-1.5">
            <span class="text-xs font-semibold text-[var(--ink-soft)]">📸 题目拍照答疑与思路启发</span>
            <div class="font-display text-2xl font-black text-[var(--ink)] font-mono">
              {{ activeVisTier === 'plus' ? '约 120 题' : '约 600 题' }}
              <span class="text-xs font-normal text-[var(--ink-soft)]">/周</span>
            </div>
            <p class="text-[11px] text-[var(--ink-soft)]">
              {{ activeVisTier === 'plus' ? '日常课后难点、错题随拍随解' : '超大题量支持，攻坚各省中高考真题' }}
            </p>
          </div>

          <div class="p-4 rounded-2xl bg-[#faf6f0] border border-[#eee2d0] space-y-1.5">
            <span class="text-xs font-semibold text-[var(--ink-soft)]">📝 全真模拟考场组卷</span>
            <div class="font-display text-2xl font-black text-[var(--ink)] font-mono">
              {{ activeVisTier === 'plus' ? '约 10 套' : '约 50 套' }}
              <span class="text-xs font-normal text-[var(--ink-soft)]">/周</span>
            </div>
            <p class="text-[11px] text-[var(--ink-soft)]">
              {{ activeVisTier === 'plus' ? '标准考题组卷，全自动化考后批改' : '期末/中考高难度仿真卷，附详尽考情报告' }}
            </p>
          </div>

          <div class="p-4 rounded-2xl bg-[#faf6f0] border border-[#eee2d0] space-y-1.5">
            <span class="text-xs font-semibold text-[var(--ink-soft)]">🧠 个人错题本与知识画像</span>
            <div class="font-display text-2xl font-black text-[var(--accent-strong)]">
              永久免费
            </div>
            <p class="text-[11px] text-[var(--ink-soft)]">
              哪怕当周积分用尽，已存错题与画像永不锁定
            </p>
          </div>
        </div>

        <!-- 备用加油包说明卡 -->
        <div class="p-4 rounded-2xl border border-[var(--line)] bg-white flex flex-col sm:flex-row items-center justify-between gap-4">
          <div class="space-y-0.5">
            <span class="text-xs font-bold text-[var(--ink)]">考前冲刺算力告急？备用加油包随充随用</span>
            <p class="text-xs text-[var(--ink-soft)]">
              单次充值 1,500 积分起（$1.99），每 500 积分加收 $0.50。充值积分支持跨周永久使用，永不清零。
            </p>
          </div>
          <router-link
            :to="{ name: 'setup', hash: '#credits' }"
            class="text-xs font-bold text-[var(--accent-strong)] bg-[var(--accent-soft)] px-3.5 py-2 rounded-xl hover:bg-[var(--accent)] hover:text-white transition-colors shrink-0"
          >
            前往充值加电包 &rarr;
          </router-link>
        </div>
      </section>

      <!-- 常见问题手风琴（FAQ Accordion） -->
      <section class="max-w-3xl mx-auto space-y-6">
        <div class="text-center space-y-1.5">
          <div class="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--ink-soft)]">
            <HelpCircle :size="14" />
            <span>透明承诺</span>
          </div>
          <h2 class="font-display text-2xl font-bold text-[var(--ink)]">常见问题与保障</h2>
        </div>

        <div class="space-y-3">
          <div
            v-for="(faq, index) in faqs"
            :key="faq.q"
            class="clay-panel rounded-2xl p-5 cursor-pointer transition-all select-none"
            @click="toggleFaq(index)"
          >
            <div class="flex items-center justify-between gap-4 font-display text-sm font-bold text-[var(--ink)]">
              <span>{{ faq.q }}</span>
              <ChevronDown
                :size="16"
                class="transition-transform duration-200 text-[var(--ink-soft)] shrink-0"
                :class="{ 'rotate-180 text-[var(--accent)]': openFaqIndex === index }"
              />
            </div>
            <p
              v-show="openFaqIndex === index"
              class="text-xs leading-relaxed text-[var(--ink-soft)] mt-3 pt-3 border-t border-[var(--line)]"
            >
              {{ faq.a }}
            </p>
          </div>
        </div>
      </section>

      <!-- 服务承诺与运营主体说明 -->
      <section class="max-w-3xl mx-auto clay-panel rounded-2xl p-6 text-xs text-[var(--ink-soft)] leading-relaxed space-y-2">
        <div class="flex items-center gap-2 font-bold text-[var(--ink)] text-sm mb-1">
          <ShieldCheck :size="16" class="text-[var(--accent-strong)]" />
          <span>合规与消费者权利说明</span>
        </div>
        <p>博文 Boen 由个人开发者潘涵宇（Frost Tech 个人品牌）独立维护。支付由合规 Merchant of Record 服务商 Waffo Pancake 处理并代缴适用税费，本站不接触任何银行卡号与敏感密码。</p>
        <p>支持邮箱：<a href="mailto:phy55015@hotmail.com" class="text-[var(--accent-strong)] underline">phy55015@hotmail.com</a>。遇扣款疑问、试用咨询或故障反馈，均在 24 小时内人工响应处理。</p>
      </section>

      <!-- 页脚版权与法律链接 -->
      <footer class="flex flex-wrap justify-between items-center gap-4 pt-4 pb-8 text-xs text-[var(--ink-soft)] border-t border-[var(--line)]">
        <span>© 2026 Pan Hanyu · Frost Tech · 博文 Boen</span>
        <div class="flex gap-5 font-medium">
          <router-link to="/terms" class="hover:text-[var(--ink)] underline underline-offset-4">服务条款</router-link>
          <router-link to="/privacy" class="hover:text-[var(--ink)] underline underline-offset-4">隐私政策</router-link>
        </div>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.clay-tier-card {
  background: #ffffff;
  border: 1px solid var(--line);
  box-shadow: 0 10px 30px -6px rgba(44, 39, 34, 0.07), 0 2px 8px -2px rgba(44, 39, 34, 0.04);
}

.pro-tier-card {
  background: linear-gradient(150deg, #23252b 0%, #131418 100%);
  color: #ffffff;
  box-shadow: 0 16px 44px -8px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(245, 158, 11, 0.35) inset;
}

.clay-panel {
  background: #ffffff;
  border: 1px solid var(--line);
  box-shadow: 0 4px 16px -2px rgba(44, 39, 34, 0.04);
}

.tier-btn-primary {
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%);
  color: #ffffff;
  box-shadow: 0 6px 18px -3px var(--accent-glow);
}

.tier-btn-gold {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  color: #ffffff;
  box-shadow: 0 6px 20px -3px rgba(217, 119, 6, 0.45);
}

.gold-glow {
  text-shadow: 0 0 14px rgba(245, 158, 11, 0.4);
}
</style>
