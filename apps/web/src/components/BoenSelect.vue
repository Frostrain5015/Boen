<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronDown } from 'lucide-vue-next';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

const props = defineProps<{
  modelValue: string;
  options: (SelectOption | SelectGroup)[];
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const isOpen = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const dropdownRef = ref<HTMLElement | null>(null);
const highlightedIndex = ref(-1);

function isGroup(item: SelectOption | SelectGroup): item is SelectGroup {
  return 'options' in item;
}

const flatOptions = computed(() => {
  const result: SelectOption[] = [];
  for (const item of props.options) {
    if (isGroup(item)) result.push(...item.options);
    else result.push(item);
  }
  return result;
});

const selectedLabel = computed(() =>
  flatOptions.value.find(o => o.value === props.modelValue)?.label ?? props.placeholder ?? '',
);

function toggle() {
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    highlightedIndex.value = flatOptions.value.findIndex(o => o.value === props.modelValue);
    nextTick(() => dropdownRef.value?.focus());
  }
}

function select(opt: SelectOption) {
  emit('update:modelValue', opt.value);
  isOpen.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (!isOpen.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      isOpen.value = true;
      highlightedIndex.value = flatOptions.value.findIndex(o => o.value === props.modelValue);
      nextTick(() => dropdownRef.value?.focus());
    }
    return;
  }
  const len = flatOptions.value.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlightedIndex.value = (highlightedIndex.value + 1) % len;
    scrollToHighlighted();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlightedIndex.value = (highlightedIndex.value - 1 + len) % len;
    scrollToHighlighted();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (highlightedIndex.value >= 0) select(flatOptions.value[highlightedIndex.value]);
  } else if (e.key === 'Escape') {
    isOpen.value = false;
    triggerRef.value?.focus();
  }
}

function scrollToHighlighted() {
  nextTick(() => {
    const el = dropdownRef.value?.querySelector<HTMLElement>('.boen-select-item.highlighted');
    el?.scrollIntoView({ block: 'nearest' });
  });
}

function onClickOutside(e: MouseEvent) {
  if (!isOpen.value) return;
  const root = triggerRef.value?.closest('.boen-select-root');
  if (root && !root.contains(e.target as Node)) isOpen.value = false;
}

onMounted(() => document.addEventListener('mousedown', onClickOutside));
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside));
</script>

<template>
  <div class="boen-select-root relative">
    <button
      ref="triggerRef"
      type="button"
      class="boen-select-trigger"
      :class="{ open: isOpen }"
      @click="toggle"
      @keydown="onKeydown"
      role="combobox"
      :aria-expanded="isOpen"
    >
      <span class="boen-select-value" :class="{ placeholder: !props.modelValue }">
        {{ selectedLabel }}
      </span>
      <ChevronDown class="boen-select-chevron" :class="{ rotated: isOpen }" />
    </button>

    <Transition name="boen-dropdown">
      <div
        v-if="isOpen"
        ref="dropdownRef"
        class="boen-select-dropdown"
        role="listbox"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <template v-for="(item, gi) in options" :key="gi">
          <template v-if="isGroup(item)">
            <div class="boen-select-group-label">{{ item.label }}</div>
            <button
              v-for="(opt, oi) in item.options"
              :key="opt.value"
              type="button"
              class="boen-select-item"
              :class="{
                selected: opt.value === modelValue,
                highlighted: flatOptions.indexOf(opt) === highlightedIndex,
              }"
              @click="select(opt)"
              @mouseenter="highlightedIndex = flatOptions.indexOf(opt)"
              role="option"
              :aria-selected="opt.value === modelValue"
            >
              {{ opt.label }}
            </button>
          </template>
          <template v-else>
            <button
              :key="item.value"
              type="button"
              class="boen-select-item"
              :class="{
                selected: item.value === modelValue,
                highlighted: flatOptions.indexOf(item) === highlightedIndex,
              }"
              @click="select(item)"
              @mouseenter="highlightedIndex = flatOptions.indexOf(item)"
              role="option"
              :aria-selected="item.value === modelValue"
            >
              {{ item.label }}
            </button>
          </template>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.boen-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  height: 2.75rem;
  padding: 0 0.85rem;
  border-radius: 14px;
  border: 1.5px solid var(--line);
  background: rgba(255, 255, 255, 0.75);
  font-family: var(--font-display);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--ink);
  outline: none;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
  -webkit-user-select: none;
  user-select: none;
}
.boen-select-trigger:hover {
  border-color: var(--accent);
  background: rgba(255, 255, 255, 0.9);
}
.boen-select-trigger.open,
.boen-select-trigger:focus-visible {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  background: #fff;
}

.boen-select-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.boen-select-value.placeholder {
  color: var(--ink-soft);
  font-weight: 500;
}

.boen-select-chevron {
  width: 1rem;
  height: 1rem;
  color: var(--ink-soft);
  flex-shrink: 0;
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.boen-select-chevron.rotated {
  transform: rotate(180deg);
}

.boen-select-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 50;
  max-height: 260px;
  overflow-y: auto;
  scrollbar-width: thin;
  padding: 4px;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: #fff;
  box-shadow: 0 12px 32px -8px rgba(86, 64, 40, 0.18), 0 4px 12px -4px rgba(86, 64, 40, 0.1);
  outline: none;
}

.boen-select-group-label {
  padding: 0.4rem 0.65rem 0.2rem;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-soft);
  opacity: 0.7;
}

.boen-select-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0.5rem 0.7rem;
  border-radius: 10px;
  border: none;
  background: transparent;
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, transform 0.12s;
  text-align: left;
  outline: none;
}
.boen-select-item:hover,
.boen-select-item.highlighted {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.boen-select-item.selected {
  background: var(--accent);
  color: #fff;
}
.boen-select-item:active {
  transform: scale(0.97);
}

/* Dropdown transition */
.boen-dropdown-enter-active {
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.boen-dropdown-leave-active {
  transition: opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1), transform 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}
.boen-dropdown-enter-from,
.boen-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}
.boen-dropdown-enter-to,
.boen-dropdown-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1);
}
</style>
