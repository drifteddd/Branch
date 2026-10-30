// your community identity, without an account. the app makes a random secret key the
// first time and keeps it on this computer. the server only stores a hash of it, and
// gives you a random name you can change in settings.
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
    // storage blocked: a key that only lasts until the app closes
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

// starts over with a brand new identity (and a new random name)
export function resetIdentity() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
  cached = null;
  me = null;
}
