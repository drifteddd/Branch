import { h } from "./dom.js";
import { icon } from "./icons.js";
import { api } from "./platform.js";
import { forumKey, myAccount, myIdentity } from "./forum-identity.js";

const KEY = "branch.profile";
export const AVATAR_ICONS = ["sprout", "tree", "flame", "crown", "star", "sparkle", "compass", "gift", "award", "radar", "bell", "layers"];
export const AVATAR_COLORS = ["#1fa889", "#2f7cf6", "#8e5cf7", "#e0569b", "#f2683c", "#f5b301", "#20a4c9", "#5a9e3a", "#d14b4b", "#6b6f80"];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function readLocal() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY));
    if (p && AVATAR_COLORS.includes(p.color) && AVATAR_ICONS.includes(p.icon)) return p;
  } catch {
  }
  return null;
}

function writeLocal(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
  }
}

export function localAvatar() {
  let p = readLocal();
  if (!p) {
    p = { color: pick(AVATAR_COLORS), icon: pick(AVATAR_ICONS) };
    writeLocal(p);
  }
  return p;
}

export async function myProfile() {
  const avatar = localAvatar();
  let account = null;
  try {
    account = (await myAccount()).account;
  } catch {
  }
  if (account) {
    const saved = account.avatar;
    if (saved && AVATAR_COLORS.includes(saved.color) && AVATAR_ICONS.includes(saved.icon)) {
      writeLocal(saved);
      return { name: account.username, avatar: saved, account: true };
    }
    api("/api/account/avatar", { method: "POST", body: { key: forumKey(), ...avatar } }).catch(() => {});
    return { name: account.username, avatar, account: true };
  }
  let name = "you";
  try {
    name = (await myIdentity()).name;
  } catch {
  }
  return { name, avatar, account: false };
}

export async function setAvatar(avatar) {
  writeLocal(avatar);
  const me = await myAccount().catch(() => null);
  if (me?.account) {
    await api("/api/account/avatar", { method: "POST", body: { key: forumKey(), ...avatar } });
    me.account.avatar = avatar;
  }
  window.dispatchEvent(new Event("branch-profile"));
}

export function avatarEl(avatar, size = 40) {
  return h("span", { class: "avatar", style: `--avatar:${avatar.color};width:${size}px;height:${size}px`, "aria-hidden": "true" }, icon(avatar.icon));
}

export function avatarPicker(onPick) {
  let current = localAvatar();
  const preview = h("span", { class: "avatar-preview" });
  const colors = h("div", { class: "avatar-colors", role: "radiogroup", "aria-label": "Colour" });
  const icons = h("div", { class: "avatar-icons", role: "radiogroup", "aria-label": "Icon" });
  function draw() {
    preview.replaceChildren(avatarEl(current, 56));
    colors.replaceChildren(
      ...AVATAR_COLORS.map((c) =>
        h("button", { type: "button", class: `avatar-swatch${c === current.color ? " on" : ""}`, style: `--avatar:${c}`, role: "radio", "aria-checked": String(c === current.color), "aria-label": `Colour ${c}`, onclick: () => choose({ ...current, color: c }) }),
      ),
    );
    icons.replaceChildren(
      ...AVATAR_ICONS.map((i) =>
        h("button", { type: "button", class: `avatar-icon-btn${i === current.icon ? " on" : ""}`, role: "radio", "aria-checked": String(i === current.icon), "aria-label": i, onclick: () => choose({ ...current, icon: i }) }, icon(i)),
      ),
    );
  }
  async function choose(next) {
    current = next;
    draw();
    try {
      await setAvatar(next);
      onPick?.(next, null);
    } catch (err) {
      onPick?.(next, err);
    }
  }
  const random = h("button", { class: "btn btn-small", type: "button", onclick: () => choose({ color: pick(AVATAR_COLORS), icon: pick(AVATAR_ICONS) }) }, "Random");
  draw();
  return h("div", { class: "avatar-picker" }, h("div", { class: "avatar-picker-top" }, preview, random), colors, icons);
}
