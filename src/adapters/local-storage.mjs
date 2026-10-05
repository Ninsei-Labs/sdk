// A READY-MADE STORAGE ADAPTER FOR THE BROWSER. The only SDK file allowed to touch the DOM.
//
// Why it is kept separate and wired in explicitly: the SDK core must load in bare Node (this is checked by
// machine), while `localStorage` exists only in the browser. An interface that needs browser storage writes
// `import { localStorageAdapter } from "@ninsei-labs/sdk/adapters"` - that is, it makes the DOM decision.
//
// The adapter is deliberately thin: the swap storage is the interface's data, and it may replace it with
// sessionStorage, IndexedDB or memory (tests).

export function localStorageAdapter(scope = "ninsei.sdk") {
  const key = (name) => scope + "." + name;
  return {
    get(name) {
      return localStorage.getItem(key(name));
    },
    set(name, value) {
      localStorage.setItem(key(name), String(value));
    },
    remove(name) {
      localStorage.removeItem(key(name));
    },
  };
}

export function memoryAdapter(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (name) => (map.has(name) ? map.get(name) : null),
    set: (name, value) => map.set(name, String(value)),
    remove: (name) => map.delete(name),
  };
}
