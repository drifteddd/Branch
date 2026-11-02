import { h } from "./dom.js";
import { icon } from "./icons.js";
import { toast, confirmDialog } from "./ui.js";
import { signUp, logIn, logOut, changePassword } from "./forum-identity.js";

function passwordInput(id, autocomplete) {
  const input = h("input", { class: "input", id, type: "password", autocomplete, maxlength: "200" });
  const toggle = h("button", { class: "btn btn-quiet btn-small acct-show", type: "button", "aria-label": "Show password", "aria-pressed": "false" }, "Show");
  toggle.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", String(show));
  });
  return { input, wrap: h("div", { class: "acct-pass" }, input, toggle) };
}

export function accountGate({ onDone }) {
  let mode = "signup";
  const username = h("input", { class: "input", id: "acct-username", maxlength: "20", autocomplete: "username", spellcheck: "false", placeholder: "pick a username" });
  const pass = passwordInput("acct-password", "new-password");
  const errorFor = (key) => h("p", { class: "error", "data-error": key, hidden: true });
  const formError = h("div", { class: "banner danger compact", role: "alert", hidden: true });
  const submit = h("button", { class: "btn btn-primary btn-large", type: "submit" });
  const passHint = h("p", { class: "hint" });
  const title = h("h2", { id: "acct-title" });
  const tabs = h(
    "div",
    { class: "segmented acct-tabs", role: "radiogroup", "aria-label": "Account" },
    [["signup", "Create account"], ["login", "Log in"]].map(([value, label]) =>
      h("label", null, h("input", { type: "radio", name: "acct-mode", value, checked: value === mode, onchange: () => setMode(value) }), h("span", null, label)),
    ),
  );

  function setMode(next) {
    mode = next;
    title.textContent = mode === "signup" ? "Create your creator account" : "Log in to your creator account";
    submit.textContent = mode === "signup" ? "Create account" : "Log in";
    pass.input.autocomplete = mode === "signup" ? "new-password" : "current-password";
    username.placeholder = mode === "signup" ? "pick a username" : "your username";
    passHint.textContent = mode === "signup" ? "at least 8 characters. there's no email, so write it down somewhere safe. Branch can't reset it for you." : "";
    passHint.hidden = mode !== "signup";
    clearErrors();
  }

  function clearErrors() {
    formError.hidden = true;
    for (const p of form.querySelectorAll("[data-error]")) p.hidden = true;
  }

  const form = h(
    "form",
    { class: "rw-card acct-form", novalidate: true, "aria-labelledby": "acct-title" },
    tabs,
    title,
    h("div", { class: "field" }, h("label", { for: "acct-username" }, "Username"), username, errorFor("username")),
    h("div", { class: "field" }, h("label", { for: "acct-password" }, "Password"), pass.wrap, passHint, errorFor("password")),
    formError,
    submit,
  );
  setMode(mode);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    submit.disabled = true;
    try {
      const result = mode === "signup" ? await signUp(username.value.trim(), pass.input.value) : await logIn(username.value.trim(), pass.input.value);
      toast(mode === "signup" ? `Welcome, ${result.username}! your account is ready.` : `Logged in as ${result.username}`, { tone: "ok" });
      onDone?.();
    } catch (err) {
      let shown = false;
      for (const [key, message] of Object.entries(err.fields || {})) {
        const p = form.querySelector(`[data-error="${key}"]`);
        if (p) {
          p.textContent = message;
          p.hidden = false;
          shown = true;
        }
      }
      if (!shown) {
        formError.textContent = err.message;
        formError.hidden = false;
      }
      submit.disabled = false;
    }
  });

  const perks = [
    ["hub", "Creator hub", "levels, badges, download stats and your creator rank."],
    ["edit", "Edit your mods", "change the name, description, pictures and video any time, and post new versions."],
    ["gift", "Robux rewards", "earn Robux for your unique uploads."],
    ["user", "Use any computer", "log in anywhere to manage your mods."],
  ];
  return h(
    "div",
    { class: "acct-gate" },
    h(
      "header",
      { class: "ch-hero acct-hero" },
      h("div", { class: "ch-hero-glow", "aria-hidden": "true" }),
      h(
        "div",
        { class: "ch-hero-text" },
        h("span", { class: "rw-pill" }, icon("hub"), "Creator hub"),
        h("h1", { id: "hub-title" }, "Make a free creator account"),
        h("p", null, "just a username and password. no email, no personal info. you only need an account if you want to manage your uploads and earn rewards. you can still upload mods without one."),
      ),
    ),
    h(
      "div",
      { class: "acct-grid" },
      form,
      h("ul", { class: "acct-perks" }, perks.map(([iconName, name, text]) => h("li", null, h("span", { class: "ch-tile-icon" }, icon(iconName)), h("div", null, h("strong", null, name), h("p", { class: "muted small" }, text))))),
    ),
  );
}

function passwordDialog() {
  const current = passwordInput("acct-current", "current-password");
  const next = passwordInput("acct-new", "new-password");
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const save = h("button", { class: "btn btn-primary", type: "submit" }, "Change password");
  const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
  const form = h(
    "form",
    { class: "sheet-body", novalidate: true },
    h("h2", { class: "sheet-title", id: "acct-pw-title" }, "Change password"),
    h("div", { class: "field" }, h("label", { for: "acct-current" }, "Current password"), current.wrap),
    h("div", { class: "field" }, h("label", { for: "acct-new" }, "New password"), next.wrap, h("p", { class: "hint" }, "at least 8 characters. other computers logged in to your account get logged out.")),
    error,
    h("div", { class: "sheet-actions" }, cancel, save),
  );
  const dialog = h("dialog", { class: "sheet", "aria-labelledby": "acct-pw-title" }, form);
  cancel.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    save.disabled = true;
    try {
      await changePassword(current.input.value, next.input.value);
      toast("Password changed", { tone: "ok" });
      dialog.close();
    } catch (err) {
      error.textContent = err.fields?.current || err.fields?.password || err.message;
      error.hidden = false;
      save.disabled = false;
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  current.input.focus();
}

export function accountBar(account, { onLogout }) {
  const out = h("button", { class: "btn btn-quiet btn-small", type: "button", id: "acct-logout" }, "Log out");
  out.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Log out?", message: "you can log back in any time with your username and password.", confirmLabel: "Log out" });
    if (!ok) return;
    await logOut();
    toast("Logged out");
    onLogout?.();
  });
  return h(
    "div",
    { class: "acct-bar" },
    h("span", { class: "acct-who" }, icon("user"), "Logged in as ", h("strong", null, account.username)),
    h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: passwordDialog }, "Change password"),
    out,
  );
}
