<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ avatar: string }>();
const emit = defineEmits<{ 'update:avatar': [value: string] }>();

const showPicker = ref(false);

const AVATARS = [
  'avatar-1.jpg', 'avatar-2.jpg', 'avatar-3.jpg', 'avatar-4.jpg',
  'avatar-5.jpg', 'avatar-6.jpg', 'avatar-7.jpg', 'avatar-8.jpg',
  'avatar-9.jpg', 'avatar-10.jpg', 'avatar-11.jpg', 'avatar-12.jpg',
  'avatar-13.jpg', 'avatar-14.jpg', 'avatar-15.jpg',
];

function avatarUrl(file: string) {
  return `/avatars/${file}`;
}

function selectAvatar(file: string) {
  emit('update:avatar', avatarUrl(file));
  showPicker.value = false;
}

function isCurrent(file: string) {
  return props.avatar === avatarUrl(file);
}

function open() {
  showPicker.value = true;
}

function close() {
  showPicker.value = false;
}
</script>

<template>
  <!-- 遮罩层 -->
  <Teleport to="body">
    <div
      v-if="showPicker"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="mx-4 w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl"
      >
        <div class="mb-4 flex items-center justify-between">
          <h3 class="text-sm font-bold text-gray-800">选择头像</h3>
          <button
            @click="close"
            class="grid h-7 w-7 place-items-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="max-h-64 overflow-y-auto pr-1">
          <div class="grid grid-cols-4 gap-2">
            <button
              v-for="file in AVATARS"
              :key="file"
              @click="selectAvatar(file)"
              class="group relative flex items-center justify-center rounded-2xl p-1.5 transition-all hover:bg-indigo-50 active:scale-90"
              :class="{ 'bg-indigo-50 ring-2 ring-indigo-400': isCurrent(file) }"
            >
              <div class="h-12 w-12 overflow-hidden rounded-full md:h-14 md:w-14">
                <img
                  :src="avatarUrl(file)"
                  alt=""
                  class="h-full w-full object-cover"
                />
              </div>
              <div
                v-if="isCurrent(file)"
                class="absolute -right-0.5 -top-0.5 grid h-5 w-5 place-items-center rounded-full bg-indigo-500 text-white shadow"
              >
                <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 触发按钮：包裹头像，点击弹起选择器 -->
  <button
    @click="open"
    class="group relative grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--accent-soft)] transition-all hover:ring-2 hover:ring-[var(--accent)] active:scale-95"
    title="点击更换头像"
  >
    <img
      v-if="props.avatar"
      :src="props.avatar"
      alt=""
      class="h-full w-full object-cover"
    />
    <svg v-else class="h-6 w-6 text-[var(--accent-strong)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
    <!-- 悬停提示 -->
    <div class="absolute inset-0 flex items-center justify-center rounded-full bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
      <svg class="h-5 w-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg>
    </div>
  </button>
</template>

<style scoped>
.max-h-64::-webkit-scrollbar {
  width: 4px;
}
.max-h-64::-webkit-scrollbar-track {
  background: transparent;
}
.max-h-64::-webkit-scrollbar-thumb {
  background: #d1d5db;
  border-radius: 99px;
}
.max-h-64::-webkit-scrollbar-thumb:hover {
  background: #9ca3af;
}
</style>
