/**
 * concurrency.ts — 并发限制器 + 429 退避重试
 *
 * 用于考试出题流水线的三个并发阶段（出题/审核/重出），
 * 超过 limit 的任务自动排队，等 worker 空闲后串行接续。
 * 遇到 429 Too Many Requests 时指数退避后重新入队。
 */
/**
 * 受限并发的 allSettled。
 * 超过 limit 的任务排队等待，429 时退避重试。
 */
export async function withConcurrencyLimit(tasks, options) {
    const opts = typeof options === 'number'
        ? { limit: options }
        : options;
    const { limit, maxRetries = 2, baseDelayMs = 1000, verbose = true } = opts;
    const results = new Array(tasks.length);
    let nextIndex = 0;
    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= tasks.length)
                return;
            let lastError;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const value = await tasks[i]();
                    results[i] = { status: 'fulfilled', value };
                    break;
                }
                catch (err) {
                    // 识别限流：HTTP 429 或 message 含 "rate limit" / "too many requests"
                    const isRateLimit = err?.status === 429
                        || err?.response?.status === 429
                        || /rate\s*limit|too\s*many\s*requests|429/i.test(err?.message ?? '');
                    if (isRateLimit && attempt < maxRetries) {
                        const delay = baseDelayMs * Math.pow(2, attempt);
                        if (verbose) {
                            console.warn(`[concurrency] 任务 #${i} 触发限流，${delay}ms 后重试（第 ${attempt + 1}/${maxRetries} 次）`);
                        }
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                    lastError = err;
                    break;
                }
            }
            if (results[i] === undefined) {
                results[i] = { status: 'rejected', reason: lastError };
            }
        }
    }
    // 启动 limit 个 worker
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
}
/**
 * 简单的信号量（不处理 429，仅限流）。
 * 适用于非 LLM 调用的并发控制。
 */
export class Semaphore {
    max;
    available;
    waiters = [];
    constructor(max) {
        this.max = max;
        this.available = max;
    }
    async acquire() {
        if (this.available > 0) {
            this.available--;
            return;
        }
        await new Promise(resolve => this.waiters.push(resolve));
        this.available--;
    }
    release() {
        this.available++;
        const next = this.waiters.shift();
        if (next) {
            // 唤醒一个等待者，它会从 acquire 中返回并再次减 available
            next();
        }
    }
    /** 用信号量包裹一个 async 函数 */
    async run(fn) {
        await this.acquire();
        try {
            return await fn();
        }
        finally {
            this.release();
        }
    }
}
