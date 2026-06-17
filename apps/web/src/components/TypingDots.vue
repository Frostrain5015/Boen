<template>
  <div class="dots" aria-label="博文正在思考">
    <span></span><span></span><span></span>
  </div>
</template>

<style scoped>
.dots { display: inline-flex; gap: 5px; align-items: center; padding: 4px 2px; }
.dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  transition: background-color 0.5s;
  animation: dotJump 1.3s ease-in-out infinite;
}
.dots span:nth-child(2) { animation-delay: 0.18s; }
.dots span:nth-child(3) { animation-delay: 0.36s; }
</style>
