<script setup lang="ts">
import { ref } from 'vue';
import { X } from 'lucide-vue-next';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ close: [] }>();

function close() { emit('close'); }

function onClickOutside(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('tos-overlay')) close();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="tos-fade">
      <div
        v-if="show"
        class="tos-overlay fixed inset-0 z-[999] flex items-center justify-center bg-black/30 backdrop-blur-sm px-4"
        @click="onClickOutside"
      >
        <div
          class="relative flex max-h-[80vh] w-full max-w-xl flex-col rounded-2xl bg-white shadow-2xl"
          v-motion
          :initial="{ opacity: 0, y: 30, scale: 0.95 }"
          :enter="{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 300, damping: 25 } }"
        >
          <!-- 头部 -->
          <div class="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
            <h2 class="font-display text-lg font-bold text-[var(--ink)]">服务条款</h2>
            <button @click="close" class="grid h-8 w-8 place-items-center rounded-xl text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]" aria-label="关闭">
              <X class="h-5 w-5" />
            </button>
          </div>

          <!-- 内容 -->
          <div class="overflow-y-auto px-6 py-5 text-sm leading-relaxed text-[var(--ink)] space-y-4 [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-bold [&_p]:mb-2 [&_ul]:pl-5 [&_ul]:mb-2 [&_li]:list-disc">
            <p class="text-xs text-[var(--ink-soft)]">最后更新日期：2026 年 6 月 24 日</p>

            <h3>1. 总则</h3>
            <p>
              欢迎使用「博文 Boen」（以下简称"本服务"）。本服务由寒霜科技（Frostrain Tech）提供，
              是一款面向中小学生及大学生的 AI 学习辅助工具。在开始使用前，请您仔细阅读本服务条款。
              通过登录并使用本服务，即表示您已阅读、理解并同意受本条款的约束。
            </p>

            <h3>2. 用户账户与安全</h3>
            <p>
              2.1 您需通过 Frost ID 或其他授权方式注册账户后方可使用本服务。您应对注册信息的真实性负责。
            </p>
            <p>
              2.2 您应妥善保管账户信息及登录凭证。因账户信息泄露导致的任何损失，由您自行承担。
            </p>
            <p>
              2.3 <strong>未成年人特别提示：</strong>若您未满 18 周岁，请在监护人陪同下阅读并确认本条款。
              监护人应监督未成年人的使用行为，并对未成年人的使用行为承担相应责任。
            </p>

            <h3>3. 服务内容</h3>
            <p>
              3.1 本服务提供 AI 对话问答、智能出题、学习分析、错题整理等功能，覆盖数学、语文、英语、
              科学等学科的人教版课程内容。
            </p>
            <p>
              3.2 本服务中的部分功能可能设有免费使用额度，超出额度或使用高级功能需付费开通会员。
              具体以服务内公示为准。
            </p>
            <p>
              3.3 我们保留根据运营需要调整、暂停或终止部分或全部服务的权利，但会依法提前公告。
            </p>

            <h3>4. 用户行为规范</h3>
            <p>您在使用本服务时承诺遵守以下规范：</p>
            <ul>
              <li>不利用本服务从事任何违法违规活动；</li>
              <li>不干扰、破坏本服务的正常运行；</li>
              <li>不通过自动化手段（如爬虫、脚本）批量调用本服务 API；</li>
              <li>不利用本服务生成、传播违法违规或不良信息；</li>
              <li>不侵犯他人的知识产权、隐私权或其他合法权益。</li>
            </ul>
            <p>如发现违反上述规范，我们有权在不通知的情况下暂停或终止您的账户使用权。</p>

            <h3>5. 个人信息保护</h3>
            <p>
              5.1 我们重视您的个人信息安全。我们通过 Frost ID 进行身份认证，仅收集提供服务所必需的
              用户信息（包括但不限于昵称、头像、年级信息）。
            </p>
            <p>
              5.2 我们将依照《中华人民共和国个人信息保护法》及相关法律法规的要求，对您的个人信息
              进行严格保护，未经您的明确同意，不向第三方提供您的个人信息（法律法规另有规定的除外）。
            </p>
            <p>
              5.3 您的对话记录和学习数据将被加密存储，用于为您提供个性化学习服务。您有权申请删除
              您的账户及相关数据。
            </p>

            <h3>6. 知识产权</h3>
            <p>
              6.1 本服务的所有内容，包括但不限于软件代码、界面设计、课程编排、品牌标识等，其知识产权
              归寒霜科技所有，受《中华人民共和国著作权法》等法律法规保护。
            </p>
            <p>
              6.2 课程知识库内容基于人民教育出版社公开教材整理，仅供个人学习使用，不得用于商业用途。
            </p>
            <p>
              6.3 AI 生成内容的知识产权归属参照相关法律法规执行。您不得将 AI 生成内容以自己名义
              公开发布或用于商业目的。
            </p>

            <h3>7. 免责声明</h3>
            <p>
              7.1 AI 生成的内容仅供参考，不构成专业教育建议。我们尽合理努力确保内容的准确性，
              但不保证其完全正确或适用所有场景。最终学习效果以实际教学为准。
            </p>
            <p>
              7.2 因不可抗力、系统维护、网络故障等原因导致服务中断或数据丢失，我们在法律允许的
              范围内不承担责任。
            </p>
            <p>
              7.3 本服务按"现状"提供，不提供任何明示或暗示的保证。
            </p>

            <h3>8. 服务的终止</h3>
            <p>
              8.1 您可随时申请注销账户并停止使用本服务。
            </p>
            <p>
              8.2 如您违反本条款，我们有权视情况采取警告、限制功能、暂停服务或永久封禁账户等措施。
            </p>
            <p>
              8.3 账户终止后，我们将在合理期限内按照法律法规要求处理您的个人数据。
            </p>

            <h3>9. 条款的变更</h3>
            <p>
              我们有权根据需要修改本服务条款。重大变更将通过服务内公告或推送等方式通知您。
              修改后的条款自公布之日起生效。如您不同意修改后的条款，应停止使用本服务。
            </p>

            <h3>10. 法律适用与争议解决</h3>
            <p>
              10.1 本条款的订立、执行和解释均适用中华人民共和国法律。
            </p>
            <p>
              10.2 因本条款引起的或与本条款有关的争议，双方应友好协商解决；协商不成的，
              任何一方均有权将争议提交至有管辖权的人民法院诉讼解决。
            </p>

            <h3>11. 联系方式</h3>
            <p>
              如您对本条款有任何疑问或建议，可通过以下方式联系我们：<br />
              邮箱：<a href="mailto:support@frostrain.tech" class="text-[var(--accent-strong)] underline">support@frostrain.tech</a><br />
              服务提供方：寒霜科技（Frostrain Tech）
            </p>
          </div>

          <!-- 底部按钮 -->
          <div class="flex justify-end border-t border-[var(--line)] px-6 py-4">
            <button
              @click="close"
              class="btn-accent rounded-xl px-6 py-2 text-sm font-semibold"
            >
              我已阅读
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tos-fade-enter-active,
.tos-fade-leave-active {
  transition: opacity 0.25s ease;
}
.tos-fade-enter-from,
.tos-fade-leave-to {
  opacity: 0;
}
</style>
