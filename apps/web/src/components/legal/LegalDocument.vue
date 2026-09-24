<script setup lang="ts">
import { MEMBERSHIP_PLANS, MEMBERSHIP_TERMS_VERSION } from '@boen/shared';
defineProps<{ kind: 'terms' | 'privacy' }>();
const contactAddress = import.meta.env.VITE_LEGAL_CONTACT_ADDRESS?.trim() ?? '';
</script>
<template>
  <article class="legal-copy">
    <header>
      <p class="legal-kicker">BOEN LEGAL</p>
      <h1>博文 Boen {{ kind === 'terms' ? '服务条款' : '隐私政策' }}</h1>
      <p class="legal-meta">版本 {{ kind === 'terms' ? MEMBERSHIP_TERMS_VERSION : '1.1' }} · 生效及最后更新日期：2026 年 9 月 {{ kind === 'terms' ? '24' : '23' }} 日</p>
      <p>博文 Boen 由个人开发者潘涵宇（Pan Hanyu）运营。寒霜科技（Frost Tech）是其个人品牌，尚未注册企业主体。我们提供网页 AI 学习服务，不销售实体商品。</p>
      <p>网站：<a href="https://boen.frostrain.tech/pricing">boen.frostrain.tech</a>；客服、账单、退款、隐私及安全联系邮箱：<a href="mailto:phy55015@hotmail.com">phy55015@hotmail.com</a>。</p>
    </header>
    <template v-if="kind === 'terms'">
      <section><h2>1. 服务内容与使用资格</h2><p>博文面向学生及自主学习者，提供 AI 对话、试题 OCR 识别、练习与考试、错题归因及学习诊断。具体开放功能见<a href="/pricing">功能与定价</a>。AI 生成内容可能存在错误，不能替代教材核对、教师指导或专业意见，不承诺考试成绩或特定学习效果。</p><p>未满 14 岁的用户须取得监护人同意并在其指导下使用；未满 18 岁购买服务须经监护人同意。请勿提交与学习无关的敏感个人信息。</p></section>
      <section><h2>2. 账户与用户内容</h2><p>通过 Frost ID 登录，您应提供真实必要信息并保护账户。您保留上传内容的权利，同时授予我们仅为提供、维护服务所需的处理许可。您须确保有权上传试题、图片及其他内容，不得侵犯第三方著作权或隐私。</p></section>
      <section><h2>3. 合理使用与禁止行为</h2><p>不得利用本服务实施欺诈、侵权、违法考试作弊、骚扰、传播违法或儿童性剥削内容；不得上传恶意程序、绕过认证和使用限制、批量转售访问权限或损害服务稳定性。发现违规时，我们可根据严重程度限制或终止访问，并依法处理。普通学习讨论和对 AI 输出的合理核查不受影响。</p></section>
      <section><h2>4. 星月卡与免费试用</h2><p>星月卡包含月付皓月卡（USD {{ MEMBERSHIP_PLANS[0].amount }}/月）和年付星耀卡（USD {{ MEMBERSHIP_PLANS[1].amount }}/年，按年一次收取），两种方案权益相同，均包含 DeepSeek V4 Pro、全题型考试、错题智能归因和学习诊断。税费及最终应付总额在 Waffo 收银台展示。</p><p>首次订阅可享一次 7 天免费试用，每个 Frost ID 账户在两种方案中合计限一次，不因更换方案再次提供。试用期间如未在结束前取消，将在试用结束后收取所选方案的首期月费或年费，随后按月或按年续费。首次扣款日及每期结束时间以个人中心和 Waffo 账单为准。订阅尚未开放时，个人中心会明确提示，无法创建付费订单。</p></section>
      <section><h2>5. 自动续费授权与支付</h2><p>确认订阅，即表示您授权 Waffo Pancake 在试用结束及后续每个计费周期，按所选方案向您提供的付款方式自动收取费用，直至您取消。Waffo Pancake 作为 Merchant of Record 处理交易、适用税费、账单和支付退款；您的付款还受收银台展示的相关条款约束。我们不接收或存储完整银行卡号或安全码。</p><p>价格调整不会追溯已付周期；影响后续续费的变更会提前通知，您可在新价格生效前取消。付款失败时请在账单管理中更新付款方式；我们不会因失败扣款延长已付权益。</p></section>
      <section><h2>6. 在线取消与恢复</h2><p>登录后进入<strong>个人中心 → 会员与订阅 → 取消自动续费</strong>，即可在线取消，无需发送邮件。也可通过该区域的“账单与付款方式”进入 Waffo Customer Portal 管理订阅。</p><p>取消后不再自动续费，试用或已付权益保留至当前周期结束；终止前可使用“恢复自动续费”，继续按原方案的月费或年费计费。付款失败且当前周期已经结束时，取消不会增加使用时间。终止后的重新订阅不再享有首次试用。已有订阅期间不创建另一方案的重复订阅；如需从月付改为年付或反向更换，请取消续费并等待原订阅最终结束后重新选择。遇到操作问题可联系支持邮箱协助。</p></section>
      <section><h2>7. 退款政策</h2><p>重复或错误扣款、付款后未交付所购服务、导致核心功能无法使用的重大技术故障，可申请核实与退款。不提供一般无理由退款；依法必须提供的退款、撤销权或其他消费者权利不受本条限制。</p><p>请原则上在扣款或发现问题后 14 天内，将订单号、问题描述和必要证据发至支持邮箱；该期限不限制法定请求。核实后由 Waffo 按适用流程处理，批准的款项原路退回，实际到账时间取决于支付机构。部分退款不自动取消后续续费；如不希望继续扣款，请同时在线取消。因我们运营原因提前终止已付服务的，依法退还未交付部分费用。</p></section>
      <section><h2>8. 星月积分与历史权益</h2><p>星月积分为学习及签到奖励，不可购买、转让或提现，不能抵扣 Waffo 账单。2000 积分兑换 30 天奖励会员。已有订阅、试用或历史会员期间，奖励时长储存且不消耗；现有权益结束后自动开始使用。奖励会员期间开始订阅，剩余奖励暂停保留，订阅最终结束后继续使用。</p><p>历史本地会员保留原到期日及权益，到期前不开放重复订阅。兑换码与本地免费领取现已停止。奖励权益不产生现金退款。</p></section>
      <section><h2>9. 第三方服务与隐私</h2><p>本服务使用 Frost ID 认证、DeepSeek AI 模型、阿里云 OCR、百炼 Qwen 视觉模型和云服务器，以及 Waffo Pancake 支付。必要数据会为相应功能传输至这些服务商，详见<a href="/privacy">隐私政策</a>。第三方服务中断可能影响功能，我们会合理处理，但不承诺第三方始终可用。</p></section>
      <section><h2>10. 责任、终止与争议</h2><p>我们以合理努力维护服务安全与可用性。在法律允许的范围内，对不可抗力、公共网络故障及非可归责于我们的第三方异常承担相应责任。本条不免除故意、重大过失或法律规定不得排除的责任。您可通过支持邮箱申请删除 Boen 账户数据；取消订阅与删除数据是不同操作，删除前应处理现有订阅。</p><p>本条款适用中华人民共和国法律；其他地区消费者享有的强制性保护不受影响。争议可先联系支持邮箱协商，协商不成依法向有管辖权的法院提出。</p></section>
      <section><h2>11. 条款更新</h2><p>重大变更会至少提前 15 天通过站内公告或已提供的邮箱通知，注明生效时间。需重新征得同意的变更将另行获取同意。历史版本保留于版本记录，可通过支持邮箱索取。</p></section>
    </template>
    <template v-else>
      <section><h2>1. 数据控制者</h2><p>数据控制者：潘涵宇（Pan Hanyu），个人开发者；品牌：Frost Tech／寒霜科技。隐私联系邮箱：<a href="mailto:phy55015@hotmail.com">phy55015@hotmail.com</a>。暂未设立专职数据保护负责人，由运营者受理隐私请求。</p><p v-if="contactAddress">联系地址：{{ contactAddress }}</p></section>
      <section><h2>2. 我们处理的信息及用途</h2><p>Frost ID 提供用户标识、昵称、头像及授权范围内的邮箱，用于识别账户；Boen 不收集 Frost ID 密码。您设置的姓名或昵称、年级、模型及字号偏好用于个性化体验，部分保存在您的浏览器。</p><p>对话、答案、试题图片、错题、练习及考试结果、知识画像用于提供 AI 学习、OCR、历史记录和诊断。请避免上传身份证件、银行卡或与学习无关的敏感资料。</p><p>订单标识、商品、金额、币种、支付和退款状态、订阅周期、权益及积分记录用于交付、核对交易和防止重复发放。完整银行卡号及安全码由 Waffo Pancake 及其支付服务商处理，不存储于 Boen 服务器。</p><p>服务器可能记录请求时间、IP、浏览器请求头、错误与安全事件，用于运行维护和滥用防护。主动发送给客服的邮件及证据用于处理请求。我们依据提供服务所必要的合同履行、适用法律义务或依法取得的同意处理信息；不将授权范围扩大至无关用途。</p></section>
      <section><h2>3. 浏览器存储</h2><p>必要会话存储 boen_access_token、boen_oauth_pkce 用于登录和防止授权请求被篡改，关闭标签页或退出登录后按浏览器及应用机制清理。功能性本地存储包括 Boen 个人资料、字号、模型与界面偏好，可通过浏览器清除；清除后可能需要重新设置。当前未接入广告、营销 Cookie 或第三方访问分析工具。Frost ID 和 Waffo 在其页面使用的存储由各自政策说明。</p></section>
      <section><h2>4. 服务商与信息共享</h2><p>我们不出售个人信息。仅为提供所选功能、法律要求或经您同意时共享必要信息。</p><ul><li>Frost ID：身份认证及授权资料交换。</li><li>DeepSeek：处理用于 AI 解题、出题与学习诊断的相关内容，参见其<a href="https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html" target="_blank" rel="noopener noreferrer">隐私政策</a>。</li><li>阿里云：Boen 服务器托管、试题图片 OCR 识别及百炼 Qwen 视觉模型（处理图片与解题上下文），参见<a href="https://terms.aliyun.com/legal-agreement/terms/suit_bu1_ali_cloud/suit_bu1_ali_cloud202112211045_86198.html" target="_blank" rel="noopener noreferrer">阿里云隐私政策</a>。</li><li>Waffo Pancake：必要的买家标识、邮箱、订单和支付处理；请同时阅读其收银台隐私说明。</li></ul><p>AI 请求可能包含相关上下文和已保存学习内容；我们不会把银行卡资料发送给 AI 服务商。</p></section>
      <section><h2>5. 存储地点与跨境处理</h2><p>Boen 应用数据存储于中国大陆的阿里云服务器。第三方认证、AI 或支付服务可能根据其基础设施和用户所在地在其他司法辖区处理数据，具体范围以其政策及结账披露为准。涉及依法受管制的跨境传输时，我们将履行适用的告知、同意及保护要求；不以本政策宣称已取得未实际完成的认证或合同保障。</p></section>
      <section><h2>6. 保存期限与删除</h2><ul><li>账户关联及学习记录：账户使用期间保留；核实删除申请后最迟 30 天内删除或匿名化。</li><li>临时 OCR 材料：处理完成后最长 30 天。主动保存到对话或错题本的图片作为学习记录，按上一项处理。</li><li>安全日志及 Webhook 原始载荷：最长 180 天；不包含原始支付卡数据。</li><li>客服记录：请求结案后最长 2 年。</li><li>交易、权益与积分审计记录：交易或相关权益结束后 7 年；尚未解决的争议或法律要求可延长必要记录的保留。</li><li>删除后的备份：最长 30 天轮换清除，不用于恢复已处理的删除请求。</li></ul><p>浏览器本地资料由您控制；服务器删除不会自动清除其他设备上的本地存储。第三方作为独立处理者持有的信息，按其政策及法定义务保留。</p></section>
      <section><h2>7. 您的权利与联系方式</h2><p>您可通过隐私邮箱提出访问、更正、导出、删除、限制处理、撤回同意或依法反对处理的请求。我们核实必要身份后，在 30 个日历日内响应；如依法需要延长，将说明原因。撤回同意不影响此前合法处理，并可能影响依赖该数据的功能。您有权向适用的数据保护主管机关投诉。</p></section>
      <section><h2>8. 未成年人</h2><p>未满 14 岁须由监护人明确同意并指导使用；未满 18 岁购买须经监护人同意。监护人可通过隐私邮箱了解、更正或请求删除孩子的信息。发现未经必要同意收集的未成年人数据时，我们将核实并及时处理。</p></section>
      <section><h2>9. 安全与通知</h2><p>我们采用 HTTPS 传输、服务端密钥管理和访问控制。任何系统均不能保证绝对安全。发生影响个人信息的事件时，我们将及时采取补救措施，并依适用法律履行通知义务；适用的监管规则要求 72 小时时，按该期限执行。请勿在公开反馈中发送密码、令牌或支付卡数据。</p></section>
      <section><h2>10. 政策更新</h2><p>重大变更至少提前 15 天通过站内公告或已提供的邮箱通知，更新本页版本及生效日期；需同意的新增处理会另行征求同意。我们当前不发送营销通信。服务通知、账单和安全消息不属于营销邮件。使用及计费规则参见<a href="/terms">服务条款</a>。</p></section>
    </template>
  </article>
</template>
<style scoped>
.legal-copy {
  color: var(--ink);
  font-size: 0.925rem;
  line-height: 1.8;
}
.legal-copy header {
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--line);
}
.legal-copy section {
  padding-top: 1.5rem;
}
.legal-copy h1,
.legal-copy h2,
.legal-copy h3 {
  font-family: var(--font-display);
  color: var(--ink);
}
.legal-copy h1 {
  margin: 0.35rem 0 0.5rem;
  font-size: clamp(1.75rem, 5vw, 2.5rem);
  line-height: 1.2;
}
.legal-copy h2 {
  margin: 0 0 0.65rem;
  font-size: 1.08rem;
}
.legal-copy h3 {
  margin: 1rem 0 0.35rem;
  font-size: 0.95rem;
}
.legal-copy p {
  margin: 0.55rem 0;
}
.legal-copy ul {
  margin: 0.55rem 0;
  padding-left: 1.25rem;
}
.legal-copy li {
  margin: 0.35rem 0;
  list-style: disc;
}
.legal-copy a {
  color: var(--accent-strong);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.legal-kicker {
  margin: 0 !important;
  color: var(--accent-strong);
  font-family: var(--font-display);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.16em;
}
.legal-meta {
  color: var(--ink-soft);
  font-size: 0.78rem;
}
</style>
