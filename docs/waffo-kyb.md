# Boen Waffo KYB 与订阅上线记录

## 可填写的业务介绍

我叫潘涵宇（Pan Hanyu），是 Boen（博文）的独立开发者和运营者。我以 Frost Tech／寒霜科技个人品牌开发和维护这个项目，目前尚未注册企业主体。Boen 是使用 Vue 3、TypeScript 和 Node.js 构建的网页 AI 学习工具，我负责产品设计、前后端开发、部署维护及用户支持。我希望通过试题整理、练习、错题分析与学习诊断，帮助学生和自主学习者更清楚地了解自己的知识掌握情况。网站为 https://boen.frostrain.tech，联系邮箱为 phy55015@hotmail.com。我们仅提供在线数字服务，不销售实体商品。

如需添加职业经历、其他项目或社交资料，只添加本人确认且可核实的资料；不把 Frost Tech 填作注册公司。

## 可填写的产品介绍

Boen（博文）是一款面向学生与自主学习者的网页 AI 学习工具，支持试题图片 OCR 识别、AI 学习对话、练习与考试、错题智能归因和学习诊断。免费用户可使用每日限额的基础对话；星月卡包含 DeepSeek V4 Pro、全题型考试、错题归因和学习诊断，价格为 USD 3.00/月。首次订阅提供一次 7 天免费试用，试用结束后按月自动续费，直至用户取消；税费以收银台展示为准。用户可在个人中心在线取消或恢复自动续费，并通过 Waffo Customer Portal 查看账单和管理付款方式。服务在线交付，不涉及实物物流。学习及签到积分不可购买、转让或提现，仅可兑换奖励会员时长。订阅期间奖励时长暂停消耗，订阅最终结束后继续使用。

## 表单链接与身份

| 字段 | 内容 |
| --- | --- |
| 商户类型 | 个人／独立开发者 |
| 法定中文名 | 潘涵宇 |
| 英文名 | Pan Hanyu |
| 品牌 | Frost Tech／寒霜科技（个人品牌，非企业主体） |
| 产品页面 | https://boen.frostrain.tech/pricing |
| 服务条款 | https://boen.frostrain.tech/terms |
| 隐私政策 | https://boen.frostrain.tech/privacy |
| 联系邮箱 | phy55015@hotmail.com |
| 公开联系地址 | 中国浙江省杭州市西湖区留和路288号 |

证件、税务居住地、地址、实际用户数量等由运营者按真实情况填写。代码不会代为提交 KYB。

## Waffo 后台待办

- 测试商品已核实为 USD 3.00/月、trialDays=7、trialAmount=null，并包含 V4 Pro 描述。
- 验证支持邮箱，确保店铺、KYB、收据、网站一致；验证码由本人处理。
- 按后台提供的主机名和值设置 DNS TXT，验证 boen.frostrain.tech；不要猜测验证值。
- 在后台将退款政策设置为：重复或错误扣款、未交付、重大技术故障可申请核实退款；不提供一般无理由退款，法定消费者权利不受影响。原则上在扣款或发现问题后 14 天内提供订单号及问题说明，批准后原路退款。
- 配置试用转付费提醒与账单描述符；核实收银台展示法律页和退款规则。
- 用户提交 KYB；状态为 approved 才计为通过，submitted/pending 不算。
- 审核通过后发布生产商品，配置生产商户凭据和生产 Webhook。运行 waffo:check 验证 hasProdVersion、prodEnabled、环境和回调事件。
- 实际扣款验收须使用用户指定的付款账户；不得把测试卡成功当作生产交易成功。

2026-09-23 实际读取的后台状态：KYB 未提交，商品无生产版本，已注册 14 类测试 Webhook。不得把此状态描述为已经通过 KYB。

## 发布与回滚

1. 由运营者提供真实可公开联系地址，填入未跟踪的根 .env 中 VITE_LEGAL_CONTACT_ADDRESS。该值会公开进入前端构建；其他秘密不可使用 VITE_ 前缀。
2. 公开站点保持 WAFFO_ALLOW_TEST_CHECKOUT=false。审核前可公开产品与定价页，但购买入口显示“订阅即将开放”。本地测试才显式开启测试收银台。
3. 本地运行 npm test、npx tsc --noEmit -p apps/server/tsconfig.json、npm run build -w @boen/web。浏览器验收脚本为 scripts/check-membership-ui.mjs，PLAYWRIGHT_MODULE 可指定已有 Playwright 安装路径。
4. 服务器先确认 git 工作区没有未提交的受跟踪文件修改，保留 .env、data、node_modules、ecosystem.config.cjs 等现有运行文件。使用旧版本的 SQLite 连接执行在线备份，将文件保存在 apps/server/data/backups/boen-YYYYMMDDTHHMMSSZ.db。不要直接复制正在使用的 db 而遗漏 WAL。
5. git pull --ff-only origin main。执行 npm run build:release -w @boen/web；这个命令会阻止空地址或公开测试收银台的发布。成功后才 pm2 restart boen-server --update-env。
6. 验证 /api/health、未登录的 /pricing /terms /privacy、未登录管理接口的 401、非法签名的 401，以及历史会员不变。
7. 若发布失败，恢复上一版代码与前端构建。新增表兼容旧版，默认保留；不要用旧数据库覆盖发布后新增的真实订单。必要的数据恢复需先冻结写入并核对增量。

## 状态和运维

Waffo 的 active + isInTrial=true 映射为试用中；已支付权限使用 currentPeriodEnd。回调验签后反查权威订单，处理失败返回 500，拒绝邮箱或“用户最近订单”兜底。读取订阅状态时每分钟最多进行一次订单核对，创建新收银台前强制核对，避免漏回调导致重复订阅。取消与恢复操作使用客户身份会话及持久化幂等键。

有效历史本地会员保持原到期日；奖励账户以秒保存，避免四舍五入损失。付款失败不会延长权益，奖励等待订阅最终取消后启用。订阅、奖励、模型权限在请求时检查实际到期时间，不缓存有效性布尔值。

注意失败的 Webhook、未匹配订单、超过 23 小时仍未确认的支付申请／订阅操作。此类记录需要反查 Waffo 后人工核实，不能直接删除重下单。

## 隐私维护

服务每小时运行保留任务：180 天后移除 Webhook 原始载荷；删除请求在 30 天后清理学习记录、附件、图状态和偏好；已归档错题在 30 天后清理；交易审计记录按 7 个日历年清理。新增备份目录中的指定命名备份最长保留 30 天。附件删除有路径约束及可重试队列。

核实本人删除请求、处理订阅后，运行：

```sh
npx tsx apps/server/src/scripts/privacy-maintenance.ts --request-user VERIFIED_USER_ID --identity-verified
```

该命令只安排该用户的删除申请；申请后停止账户访问。不要将示例 VERIFIED_USER_ID 当作真实标识执行。客服邮箱中的记录应在结案两年后由运营者清除；服务器外的其他备份也须在 30 天内轮换。PM2 日志通过部署目录的 logrotate 配置保留最长 180 天；本机 nginx 已有每日轮换 14 份的配置，不重复注册日志路径。这些外部系统不受应用数据库任务控制，发布前须落实。

网站各页面的常驻页脚提供“功能与定价 / 服务条款 / 隐私政策”；/pricing 无需登录，展示价格、计费周期和试用转付费规则，覆盖第一轮网站自检提出的两项问题。

依法需要保留的争议交易，以 privacy_retention_holds 的 user_id 和最小必要原因标记；解除后恢复常规清理。恢复备份时必须重新应用备份后已处理的删除清单，不能重新启用已删除账户。

## 法律版本

- 1.0：2026-09-22，个人运营者及公开法律页；源代码历史 ab179ab。
- 1.1：2026-09-23，在线取消、试用、自动续费授权、奖励时长、具体保留期限与第三方服务说明。公开日期应与实际发布一致；已有用户须按条款执行重大变更通知。

依据：[Waffo 服务条款要求](https://docs.waffo.ai/zh/mor/account-reviews/tos)、[隐私政策要求](https://docs.waffo.ai/zh/mor/account-reviews/privacy-policy)。运营者联系地址、邮箱／域名验证、后台退款设置及审核决定属于外部验收项。
