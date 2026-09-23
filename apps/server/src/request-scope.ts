import type { AsyncLocalStorage } from 'node:async_hooks';

/** Bind each request to its own resource; concurrent users never switch a global model. */
export function scopedResource<T extends object>(scope: AsyncLocalStorage<string>, factory: (key: string) => T): T {
  const instances = new Map<string, T>();
  const get = (key: string): T => {
    let instance = instances.get(key);
    if (!instance) { instance = factory(key); instances.set(key, instance); }
    return instance;
  };
  return new Proxy(get('default'), {
    get(_target, key) {
      const selected = get(scope.getStore() ?? 'default');
      const value: unknown = Reflect.get(selected, key, selected);
      return typeof value === 'function' ? value.bind(selected) : value;
    },
  });
}
