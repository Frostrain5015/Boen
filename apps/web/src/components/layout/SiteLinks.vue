<template>
  <footer aria-label="网站信息" class="shrink-0 space-y-1 px-3 py-2 text-[10px] leading-4 text-[var(--ink-soft)]">
    <nav aria-label="产品与法律" class="flex flex-wrap gap-x-2 gap-y-1">
      <router-link to="/pricing">功能与定价</router-link>
      <router-link to="/terms">服务条款</router-link>
      <router-link to="/privacy">隐私政策</router-link>
      <a href="mailto:phy55015@hotmail.com" title="phy55015@hotmail.com">客服</a>
    </nav>
    <a class="inline-block" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">浙ICP备2026040257号-1</a>
  </footer>
</template>

<style scoped>
a:hover, a:focus-visible {
  color: var(--accent-strong);
  text-decoration: underline;
}
</style>
