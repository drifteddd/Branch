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
  account = null;
}

let account = null;

export async function myAccount(force = false) {
  if (account && !force) return account;
  account = await api("/api/account/me", { method: "POST", body: { key: forumKey() } });
  return account;
}

export function ownsMod(slug) {
  return Boolean(account?.account && account.mods.includes(slug));
}

export async function signUp(username, password) {
  const result = await api("/api/account/signup", { method: "POST", body: { key: forumKey(), username, password } });
  me = null;
  await myAccount(true);
  return result;
}

export async function logIn(username, password) {
  const result = await api("/api/account/login", { method: "POST", body: { key: forumKey(), username, password } });
  me = null;
  await myAccount(true);
  return result;
}

export async function logOut() {
  await api("/api/account/logout", { method: "POST", body: { key: forumKey() } }).catch(() => null);
  resetIdentity();
}

export async function changePassword(current, password) {
  return api("/api/account/password", { method: "POST", body: { key: forumKey(), current, password } });
}
