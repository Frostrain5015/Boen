<script setup lang="ts">
import { useRouter } from 'vue-router';
import { BrainCircuit } from 'lucide-vue-next';
import KnowledgeProfile from '@/components/KnowledgeProfile.vue';
import PremiumGate from '@/components/PremiumGate.vue';
import { useUiStore } from '@/stores/ui';
import { useExamStore } from '@/stores/exam';
import { useChatStore } from '@/stores/chat';
import { getToken } from '@/services/auth';
import { getConversation } from '@/services/chat';
import type { Subject, ChatItem } from '@/stores/chat';
import type { Grade } from '@boen/shared';

const router = useRouter();
const uiStore = useUiStore();
const examStore = useExamStore();

function handleBack() {
  router.push('/');
}

function handlePractice(detail: { kp?: string; subject: Subject; grade: string; mode?: string }) {
  router.push('/');
  uiStore.handlePractice(detail);
}

function handleExam(detail: { subject: Subject; grade: string; durationMinutes: number; notes: string }) {
  router.push('/exam');
  examStore.handleExam(detail);
}

async function handleExplore(detail: { title: string; subject: Subject; grade: string }) {
  uiStore.startSession();
  uiStore.subject = detail.subject as any;
  const token = getToken();
  try {
    await fetch('/api/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(detail),
    });
    // 探索对话已在服务端创建完成，加载到 chatStore
    const chatStore = useChatStore();
    await chatStore.loadConversations();
    if (chatStore.conversations.length > 0) {
      const conv = chatStore.conversations[0];
      chatStore.currentConversationId = conv.id;
      const { messages } = await getConversation(conv.id);
      const restored: ChatItem[] = [];
      for (const m of messages) {
        if (m.role === 'user') restored.push({ kind: 'user', text: m.content });
        else if (m.role === 'assistant') restored.push({ kind: 'assistant', text: m.content, done: true });
      }
      chatStore.items = restored;
    }
  } catch { /* 静默 */ }
  router.push('/');
}
</script>

<template>
  <PremiumGate feature-name="知识画像分析" :icon="BrainCircuit">
    <KnowledgeProfile class="flex-1" @back="handleBack" @practice="handlePractice" @exam="handleExam" @explore="handleExplore" />
  </PremiumGate>
</template>
