/**
 * 博文 Boen 前端路由表
 *
 * 所有路由均使用懒加载（动态 import），首页打包时不会加载其他页面的代码。
 * 认证拦截在 App.vue 层通过条件渲染实现，路由层无需全局守卫。
 */
import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // 首页：AI 对话主界面
    {
      path: '/',
      name: 'chat',
      component: () => import('@/views/ChatView.vue'),
    },
    // 学习档案：知识画像、诊断报告、推荐练习
    {
      path: '/profile',
      name: 'profile',
      component: () => import('@/views/ProfileView.vue'),
    },
    // 考试页面：配置 → 生成 → 答题 → 判卷 → 结果
    {
      path: '/exam',
      name: 'exam',
      component: () => import('@/views/ExamViewPage.vue'),
    },
    // 考试回顾：查看已提交考试的详细判卷结果
    {
      path: '/exam/:id/review',
      name: 'examReview',
      component: () => import('@/views/ExamReviewView.vue'),
      props: true,
    },
    // 错题本：拍照/文字录入错题，AI 分析错因
    {
      path: '/mistakes',
      name: 'mistakes',
      component: () => import('@/views/MistakesView.vue'),
    },
    // OAuth 回调：Frost ID 登录后的授权码回调页
    {
      path: '/auth/callback',
      name: 'authCallback',
      component: () => import('@/components/OAuthCallback.vue'),
    },
    // 设置与会员：个人信息、学习配置、会员卡管理、积分兑换
    {
      path: '/setup',
      name: 'setup',
      component: () => import('@/views/SetupView.vue'),
    },
  ],
});

export default router;
