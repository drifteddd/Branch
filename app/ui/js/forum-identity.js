import { api } from "./platform.js";

const KEY = "branch.forumKey";
let cached = null;

function newKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function forumKey() {
  try {
    let key = localStorage.getItem(KEY);
    if (!key || !/^[0-9a-f]{64}$/.test(key)) {
      key = newKey();
      localStorage.setItem(KEY, key);
    }
    return key;
  } catch {
    cached = cached || { key: newKey() };
    return cached.key;
  }
}

let me = null;

export async function myIdentity(force = false) {
  if (me && !force) return me;
  me = await api("/api/forum/me", { method: "POST", body: { key: forumKey() } });
  return me;
}

export async function rename(name) {
  me = await api("/api/forum/me", { method: "PUT", body: { key: forumKey(), name } });
  return me;
}

export async function randomName() {
  me = await api("/api/forum/me/random", { method: "POST", body: { key: forumKey() } });
  return me;
}

export function resetIdentity() {
  try {
    localStorage.removeItem(KEY);
  } catch {
  }
  cached = null;
  me = null;
}
