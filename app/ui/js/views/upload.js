// "upload a mod": anyone can share their own mod. it needs a mod file, a name and a description.
// everything else is optional, and the author can stay anonymous.
import { h, clear, formatBytes } from "../dom.js";
import { icon } from "../icons.js";
import { uploadForm } from "../platform.js";
import { forumKey } from "../forum-identity.js";
import { stateBlock } from "../ui.js";

const MIN_DESCRIPTION = 30;

export function createUploadView(ctx) {
  const el = h("section", { class: "view page", "aria-labelledby": "upload-title" });

  function field(key, label, control, { hint, required, optional } = {}) {
    control.id = control.id || `up-${key}`;
    control.setAttribute("aria-describedby", `${control.id}-hint ${control.id}-error`);
    return h(
      "div",
      { class: "field", dataset: { field: key } },
      h("label", { for: control.id }, label, required ? h("span", { class: "req", "aria-hidden": "true" }, "*") : null, optional ? h("span", { class: "muted" }, " (optional)") : null),
      control,
      hint ? h("p", { class: "hint", id: `${control.id}-hint` }, hint) : null,
      h("p", { class: "error", id: `${control.id}-error`, hidden: true }),
    );
  }

  function render() {
    let chosen = null;
    const fileInput = h("input", { type: "file", accept: ".dll,.zip", class: "visually-hidden", id: "up-file", tabindex: "-1" });
    const fileLabel = h("span", { class: "file-chosen muted" }, "no file chosen");
    const fileButton = h("button", { class: "btn", type: "button", onclick: () => fileInput.click() }, icon("upload"), "Choose mod file");
    fileInput.addEventListener("change", () => {
      chosen = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      fileLabel.textContent = chosen ? `${chosen.name} · ${formatBytes(chosen.size)}` : "no file chosen";
      fileLabel.classList.toggle("muted", !chosen);
    });

    const name = h("input", { class: "input", maxlength: "80", autocomplete: "off" });
    const description = h("textarea", { class: "textarea", rows: "6", maxlength: "5000" });
    const counter = h("span", { class: "muted small" }, `0 / ${MIN_DESCRIPTION} characters minimum`);
    description.addEventListener("input", () => {
      const n = description.value.trim().length;
      counter.textContent = n < MIN_DESCRIPTION ? `${n} / ${MIN_DESCRIPTION} characters minimum` : `${n} characters`;
    });
    const author = h("input", { class: "input", maxlength: "80", autocomplete: "off", placeholder: "your name or nickname" });
    const anonymous = h("input", { type: "checkbox", id: "up-anonymous" });
    anonymous.addEventListener("change", () => {
      author.disabled = anonymous.checked;
      if (anonymous.checked) author.value = "";
    });
    const version = h("input", { class: "input", maxlength: "40", autocomplete: "off", placeholder: "e.g. 1.0.0" });
    const category = h("select", { class: "select" }, h("option", { value: "" }, "No category"), (ctx.meta?.categories || []).map((c) => h("option", { value: c.slug }, c.name)));
    const sourceUrl = h("input", { class: "input", type: "url", maxlength: "500", autocomplete: "off", placeholder: "https://github.com/…" });
    const confirm = h("input", { type: "checkbox", id: "up-confirm" });
    const trap = h("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    const formError = h("div", { class: "banner danger compact", role: "alert", hidden: true });
    const submit = h("button", { class: "btn btn-primary btn-large", type: "submit" }, "Upload mod");

    const form = h(
      "form",
      { class: "form-card", novalidate: true },
      h(
        "div",
        { class: "field", dataset: { field: "file" } },
        h("span", { class: "field-label" }, "Mod file", h("span", { class: "req", "aria-hidden": "true" }, "*")),
        h("div", { class: "file-row" }, fileButton, fileLabel, fileInput),
        h("p", { class: "hint" }, "usually a .dll (a .zip works too), up to 50 MB."),
        h("p", { class: "error", id: "up-file-error", hidden: true }),
      ),
      field("name", "Mod name", name, { required: true }),
      field("description", "Description", description, { required: true, hint: "say what the mod does and how to use it. be accurate: misleading uploads get removed." }),
      counter,
      h(
        "div",
        { class: "field", dataset: { field: "author" } },
        h("label", { for: "up-author" }, "Author", h("span", { class: "muted" }, " (optional)")),
        Object.assign(author, { id: "up-author" }),
        h("label", { class: "inline-check", for: "up-anonymous" }, anonymous, h("span", null, "stay anonymous (shows as \"Anonymous\")")),
        h("p", { class: "error", id: "up-author-error", hidden: true }),
      ),
      h(
        "details",
        { class: "more-details" },
        h("summary", null, "More details (optional)"),
        h("div", { class: "more-grid" }, field("version", "Version", version, { optional: true }), field("category", "Category", category, { optional: true }), field("source_url", "Source code link", sourceUrl, { optional: true, hint: "if it's on github, people can read the code inside Branch." })),
      ),
      h(
        "div",
        { class: "field", dataset: { field: "confirm" } },
        h(
          "label",
          { class: "inline-check legal-check", for: "up-confirm" },
          confirm,
          h("span", null, "I confirm that I created this mod or have the right to distribute it, that the description is accurate, and that the file contains no malicious code. I understand that this upload is governed by the Terms of Use and will be publicly available."),
        ),
        h("p", { class: "error", id: "up-confirm-error", hidden: true }),
      ),
      h("div", { class: "trap", "aria-hidden": "true" }, trap),
      h("p", { class: "muted small" }, "every upload goes through Branch's automatic safety check. you can upload up to 10 mods a day."),
      formError,
      h("div", null, submit),
    );

    // as soon as someone edits a field, its old error goes away
    form.addEventListener("input", (event) => {
      const wrap = event.target.closest("[data-field]");
      if (!wrap) return;
      const error = wrap.querySelector(".error");
      if (error) error.hidden = true;
      event.target.removeAttribute("aria-invalid");
    });
    form.addEventListener("change", (event) => {
      const wrap = event.target.closest("[data-field]");
      const error = wrap?.querySelector(".error");
      if (error) error.hidden = true;
    });

    function showErrors(fields) {
      let first = null;
      for (const [key, message] of Object.entries(fields)) {
        const wrap = form.querySelector(`[data-field="${key}"]`);
        if (!wrap) continue;
        const error = wrap.querySelector(".error");
        error.textContent = message;
        error.hidden = false;
        const control = wrap.querySelector("input:not([type=checkbox]):not([type=file]), textarea, select") || wrap.querySelector("button, input");
        control?.setAttribute("aria-invalid", "true");
        if (key === "version" || key === "category" || key === "source_url") form.querySelector(".more-details").open = true;
        first = first || control;
      }
      first?.focus();
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      for (const e of form.querySelectorAll(".error")) e.hidden = true;
      for (const e of form.querySelectorAll("[aria-invalid]")) e.removeAttribute("aria-invalid");
      formError.hidden = true;

      const local = {};
      if (!chosen) local.file = "attach your mod file (.dll or .zip)";
      else if (chosen.size > 50 * 1024 * 1024) local.file = "files can be up to 50 MB";
      if (name.value.trim().length < 2) local.name = "give your mod a name";
      if (description.value.trim().length < MIN_DESCRIPTION) local.description = `describe what your mod does (at least ${MIN_DESCRIPTION} characters)`;
      if (!confirm.checked) local.confirm = "you have to confirm that you have the right to share this mod";
      if (Object.keys(local).length) return showErrors(local);

      const data = new FormData();
      data.append("name", name.value.trim());
      data.append("description", description.value.trim());
      data.append("anonymous", anonymous.checked ? "true" : "false");
      data.append("author", anonymous.checked ? "" : author.value.trim());
      data.append("version", version.value.trim());
      data.append("category", category.value);
      data.append("source_url", sourceUrl.value.trim());
      data.append("confirm", "true");
      data.append("website", trap.value);
      // your community identity, so this upload counts toward rewards
      data.append("key", forumKey());
      data.append("file", chosen, chosen.name);

      submit.disabled = true;
      submit.textContent = "Uploading and checking…";
      try {
        const result = await uploadForm("/api/submissions", data);
        const reward = result.reward;
        const rewardNote = !reward
          ? null
          : reward.earned > 0
            ? h("a", { class: "reward-note earned", href: "#/rewards" }, h("span", { class: "robux-mark" }, "R$"), `+${reward.earned} R$ added to your rewards`)
            : reward.uploads < reward.threshold
              ? h("a", { class: "reward-note", href: "#/rewards" }, icon("gift"), `${reward.uploads} / ${reward.threshold} unique mods toward Rewards`)
              : null;
        clear(el).append(
          ...[
          stateBlock({
            iconName: "check",
            title: "Your mod is live",
            message: "thanks for sharing! it passed the automatic check and is now in the mod list.",
            actions: [
              h("button", { class: "btn", type: "button", onclick: render }, "Upload another"),
              result.slug ? h("a", { class: "btn btn-primary", href: `#/mod/${encodeURIComponent(result.slug)}` }, "View your mod") : null,
            ],
          }),
          rewardNote ? h("div", { class: "reward-note-wrap" }, rewardNote) : null,
          ].filter(Boolean),
        );
        ctx.refreshLists?.();
      } catch (err) {
        if (err.fields) showErrors(err.fields);
        else {
          formError.replaceChildren(icon("alert"), h("p", null, err.message));
          formError.hidden = false;
        }
        submit.disabled = false;
        submit.textContent = "Upload mod";
      }
    });

    clear(el).append(
      h(
        "header",
        { class: "page-intro" },
        h("h1", { class: "view-title", id: "upload-title" }, "Upload a mod"),
        h("p", null, "share a mod you made with everyone on Branch. all you need is the file, a name and a description."),
      ),
      form,
    );
  }

  return { el, title: () => "Upload a mod", show() { if (!el.querySelector("form")) render(); return 0; }, hide() {} };
}
