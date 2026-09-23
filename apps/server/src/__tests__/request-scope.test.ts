import { AsyncLocalStorage } from 'node:async_hooks';
import { expect, it } from 'vitest';
import { scopedResource } from '../request-scope.js';
it('isolates interleaved model selections and preserves method binding', async () => {
  const scope = new AsyncLocalStorage<string>();
  const resource = scopedResource(scope, key => ({ key, read() { return this.key; } }));
  const results = await Promise.all(['default', 'deepseek-pro', 'default'].map(key => scope.run(key, async () => {
    await Promise.resolve();
    return resource.read();
  })));
  expect(results).toEqual(['default', 'deepseek-pro', 'default']);
  expect(resource.read()).toBe('default');
});
