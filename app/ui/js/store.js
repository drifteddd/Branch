const KEYS = {
  settings: "branch.settings",
  favorites: "branch.favorites",
  recent: "branch.recent",
};

const MAX_FAVORITES = 500;
const MAX_RECENT = 30;

function read(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}

export const changes = new EventTarget();

function slugList(key) {
  const value = read(key, []);
  return Array.isArray(value) ? value.filter((s) => typeof s === "string") : [];
}

export const settings = {
  get() {
    return { theme: "light", reduceMotion: false, ambient: "off", noAi: false, ...read(KEYS.settings, {}) };
  },
  set(patch) {
    const next = { ...this.get(), ...patch };
    write(KEYS.settings, next);
    changes.dispatchEvent(new Event("settings"));
    return next;
  },
};

export const favorites = {
  list() {
    return slugList(KEYS.favorites);
  },
  has(slug) {
    return this.list().includes(slug);
  },
  toggle(slug) {
    const list = this.list();
    const on = !list.includes(slug);
    const next = on ? [slug, ...list].slice(0, MAX_FAVORITES) : list.filter((s) => s !== slug);
    write(KEYS.favorites, next);
    changes.dispatchEvent(new Event("favorites"));
    return on;
  },
  remove(slugs) {
    write(KEYS.favorites, this.list().filter((s) => !slugs.includes(s)));
    changes.dispatchEvent(new Event("favorites"));
  },
  clear() {
    write(KEYS.favorites, []);
    changes.dispatchEvent(new Event("favorites"));
  },
};

export const recent = {
  list() {
    return slugList(KEYS.recent);
  },
  add(slug) {
    write(KEYS.recent, [slug, ...this.list().filter((s) => s !== slug)].slice(0, MAX_RECENT));
    changes.dispatchEvent(new Event("recent"));
  },
  remove(slugs) {
    write(KEYS.recent, this.list().filter((s) => !slugs.includes(s)));
  },
  clear() {
    write(KEYS.recent, []);
    changes.dispatchEvent(new Event("recent"));
  },
};
