// Durable key/value state backed by the V2 plugin storage.
//
// The V2 CLI plugin API exposes Solid stores instead of a plain get/set pair.
// This adapter restores the synchronous kv.get/kv.set shape the rest of the
// plugin uses; persistence happens asynchronously inside the host.

export function createKV(storage) {
  const [state, update] = storage.store("state", { initial: {} });

  return {
    get(key, fallback) {
      const value = state[key];
      return value === undefined ? fallback : value;
    },
    set(key, value) {
      void update((draft) => {
        draft[key] = value;
      }).catch(() => {});
    },
  };
}
