import { h } from "./dom.js";
import { icon } from "./icons.js";
import { api } from "./platform.js";
import { forumKey, myAccount, myIdentity } from "./forum-identity.js";

const KEY = "branch.profile";
const MAX_IMAGE = 60_000;
export const AVATAR_COLORS = ["#1fa889", "#2f7cf6", "#8e5cf7", "#e0569b", "#f2683c", "#f5b301", "#20a4c9", "#5a9e3a", "#d14b4b", "#6b6f80"];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const validImage = (img) => typeof img === "string" && img.startsWith("data:image/jpeg;base64,") && img.length <= MAX_IMAGE;

function clean(p) {
  if (!p || !/^#[0-9a-f]{6}$/i.test(p.color || "")) return null;
  return { color: p.color.toLowerCase(), image: validImage(p.image) ? p.image : null };
}

function readLocal() {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return null;
  }
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
    p = { color: pick(AVATAR_COLORS), image: null };
    writeLocal(p);
  }
  return p;
}

const pushToAccount = (avatar) => api("/api/account/avatar", { method: "POST", body: { key: forumKey(), color: avatar.color, image: avatar.image || null } });

export async function myProfile() {
  const avatar = localAvatar();
  let account = null;
  try {
    account = (await myAccount()).account;
  } catch {
  }
  if (account) {
    const saved = clean(account.avatar);
    if (saved) {
      writeLocal(saved);
      return { name: account.username, avatar: saved, account: true };
    }
    pushToAccount(avatar).catch(() => {});
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
  const me = await myAccount().catch(() => null);
  if (me?.account) {
    await pushToAccount(avatar);
    me.account.avatar = avatar;
  }
  writeLocal(avatar);
  window.dispatchEvent(new Event("branch-profile"));
}

export function avatarEl(avatar, size = 40) {
  const style = `--avatar:${avatar.color};width:${size}px;height:${size}px`;
  if (avatar.image) return h("span", { class: "avatar has-image", style, "aria-hidden": "true" }, h("img", { src: avatar.image, alt: "" }));
  return h("span", { class: "avatar", style, "aria-hidden": "true" }, h("span", { class: "avatar-mark" }));
}

async function squareJpeg(file) {
  if (!file || !/^image\//.test(file.type || "")) throw new Error("pick a picture (png, jpg, webp or gif)");
  if (file.size > 25 * 1024 * 1024) throw new Error("that picture is too big (25 MB max)");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("couldn't read that picture. try a different one");
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  for (const [size, quality] of [[192, 0.85], [160, 0.75], [128, 0.65]]) {
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext("2d");
    c.imageSmoothingQuality = "high";
    c.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= MAX_IMAGE) {
      bitmap.close?.();
      return url;
    }
  }
  bitmap.close?.();
  throw new Error("couldn't make that picture small enough. try a simpler one");
}

export function avatarPicker(onPick) {
  let current = localAvatar();
  const preview = h("span", { class: "avatar-preview" });
  const colors = h("div", { class: "avatar-colors", role: "radiogroup", "aria-label": "Background colour" });
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", class: "visually-hidden", tabindex: "-1", id: "avatar-file" });
  const upload = h("button", { class: "btn btn-small", type: "button", onclick: () => file.click() }, icon("image"), "Upload picture");
  const remove = h("button", { class: "btn btn-small btn-quiet", type: "button", onclick: () => choose({ ...current, image: null }) }, "Remove picture");
  const error = h("p", { class: "error", role: "alert", hidden: true });

  function draw() {
    preview.replaceChildren(avatarEl(current, 64));
    remove.hidden = !current.image;
    colors.hidden = Boolean(current.image);
    colors.replaceChildren(
      ...AVATAR_COLORS.map((c) =>
        h("button", { type: "button", class: `avatar-swatch${c === current.color ? " on" : ""}`, style: `--avatar:${c}`, role: "radio", "aria-checked": String(c === current.color), "aria-label": `Colour ${c}`, onclick: () => choose({ ...current, color: c }) }),
      ),
    );
  }

  async function choose(next) {
    const before = current;
    current = next;
    error.hidden = true;
    draw();
    try {
      await setAvatar(next);
      onPick?.(next, null);
    } catch (err) {
      current = before;
      draw();
      onPick?.(next, err);
    }
  }

  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (!chosen) return;
    try {
      choose({ ...current, image: await squareJpeg(chosen) });
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });

  draw();
  return h(
    "div",
    { class: "avatar-picker" },
    h("div", { class: "avatar-picker-top" }, preview, h("div", { class: "avatar-picker-buttons" }, upload, remove), file),
    colors,
    error,
  );
}
