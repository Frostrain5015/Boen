import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'chat',
      component: () => import('@/views/ChatView.vue'),
    },
    {
      path: '/profile',
      name: 'profile',
      component: () => import('@/views/ProfileView.vue'),
    },
    {
      path: '/exam',
      name: 'exam',
      component: () => import('@/views/ExamViewPage.vue'),
    },
    {
      path: '/exam/:id/review',
      name: 'examReview',
      component: () => import('@/views/ExamReviewView.vue'),
      props: true,
    },
    {
      path: '/mistakes',
      name: 'mistakes',
      component: () => import('@/views/MistakesView.vue'),
    },
    {
      path: '/auth/callback',
      name: 'authCallback',
      component: () => import('@/components/OAuthCallback.vue'),
    },
    {
      path: '/setup',
      name: 'setup',
      component: () => import('@/views/SetupView.vue'),
    },
  ],
});

export default router;
