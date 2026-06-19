<script setup lang="ts">
import { useChatStore } from '@/stores/chat';
import AppHeader from '@/components/layout/AppHeader.vue';
import ChatMessages from '@/components/chat/ChatMessages.vue';
import InputArea from '@/components/chat/InputArea.vue';

const chatStore = useChatStore();
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <AppHeader />
    <ChatMessages />
    <InputArea />
  </div>
</template>
