import { h, clear, formatBytes } from "../dom.js";
import { icon } from "../icons.js";
import { api, uploadForm } from "../platform.js";
import { forumKey, myAccount } from "../forum-identity.js";
import { accountGate } from "../account.js";
import { errorBlock, stateBlock, toast, thumbnail as thumbImage } from "../ui.js";
import { makeThumbnail, mediaFields } from "./upload.js";

const MIN_DESCRIPTION = 30;

export function createEditView(ctx) {
  const el = h("section", { class: "view page edit-page", "aria-labelledby": "edit-title" });
  let slug = null;
  let title = "Edit mod";

  function field(key, label, control, { hint, optional } = {}) {
    control.id = control.id || `ed-${key}`;
    return h(
      "div",
      { class: "field", dataset: { field: key } },
      h("label", { for: control.id }, label, optional ? h("span", { class: "muted" }, " (optional)") : null),
      control,
      hint ? h("p", { class: "hint" }, hint) : null,
      h("p", { class: "error", hidden: true }),
    );
  }

  function showErrors(form, fields, fallback) {
    let first = null;
    for (const [key, message] of Object.entries(fields || {})) {
      const wrap = form.querySelector(`[data-field="${key}"]`);
      const error = wrap?.querySelector(".error");
      if (!error) continue;
      error.textContent = message;
      error.hidden = false;
      first = first || wrap.querySelector("input, textarea, select, button");
    }
    if (!first && fallback) {
      fallback.replaceChildren(icon("alert"), h("p", null, Object.values(fields || {})[0] || "something went wrong"));
      fallback.hidden = false;
    }
    first?.focus();
  }

  function listingForm(mod) {
    let newThumb = null;
    let removeThumb = false;
    const thumbBox = h("div", { class: "ed-thumb" });
    const thumbInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", class: "visually-hidden", id: "ed-thumb-file", tabindex: "-1" });
    const thumbStatus = h("span", { class: "muted small", "aria-live": "polite" });
    const drawThumb = () => {
      const src = newThumb ? URL.createObjectURL(newThumb) : removeThumb ? null : mod.thumbnail_url;
      thumbBox.replaceChildren(src ? h("img", { src, alt: "thumbnail" }) : thumbImage(null, "ed-thumb-gen", mod));
    };
    thumbInput.addEventListener("change", async () => {
      const file = thumbInput.files?.[0];
      thumbInput.value = "";
      if (!file) return;
      try {
        newThumb = await makeThumbnail(file);
        removeThumb = false;
        thumbStatus.textContent = "new thumbnail ready. save to keep it.";
        drawThumb();
      } catch (err) {
        thumbStatus.textContent = err.message;
      }
    });
    drawThumb();

    const name = h("input", { class: "input", maxlength: "80", autocomplete: "off", value: mod.name });
    const description = h("textarea", { class: "textarea", rows: "8", maxlength: "5000" });
    description.value = mod.description;
    const author = h("input", { class: "input", maxlength: "80", autocomplete: "off", value: mod.author === "Anonymous" ? "" : mod.author, placeholder: "leave empty to show \"Anonymous\"" });
    const tags = h("input", { class: "input", maxlength: "140", autocomplete: "off", value: mod.tags.join(", "), placeholder: "e.g. hats, cosmetics, menu" });
    const category = h("select", { class: "select" }, h("option", { value: "" }, "No category"), (ctx.meta?.categories || []).map((c) => h("option", { value: c.slug, selected: c.slug === mod.category }, c.name)));
    const sourceUrl = h("input", { class: "input", type: "url", maxlength: "500", autocomplete: "off", value: mod.source_url || "", placeholder: "https://github.com/…" });
    const visible = h("input", { type: "checkbox", id: "ed-visible", checked: mod.status === "published" });
    const media = mediaFields("ed", { existing: mod.screenshots, videoId: mod.video_id || "" });
    const formError = h("div", { class: "banner danger compact", role: "alert", hidden: true });
    const save = h("button", { class: "btn btn-primary btn-large", type: "submit" }, "Save changes");

    const form = h(
      "form",
      { class: "form-card", novalidate: true, id: "ed-form" },
      h("h2", null, "Listing"),
      field("name", "Mod name", name),
      field("description", "Description", description, { hint: "say what the mod does and how to use it. markdown works." }),
      h(
        "div",
        { class: "field", dataset: { field: "thumbnail" } },
        h("span", { class: "field-label" }, "Thumbnail"),
        h(
          "div",
          { class: "thumb-row" },
          thumbBox,
          h(
            "div",
            { class: "thumb-side" },
            h(
              "div",
              { class: "thumb-actions" },
              h("button", { class: "btn", type: "button", onclick: () => thumbInput.click() }, icon("image"), "Change"),
              h("button", { class: "btn btn-quiet", type: "button", onclick: () => { newThumb = null; removeThumb = true; thumbStatus.textContent = "thumbnail will be removed when you save."; drawThumb(); } }, "Remove"),
            ),
            thumbStatus,
          ),
        ),
        thumbInput,
        h("p", { class: "error", hidden: true }),
      ),
      ...media.els,
      field("tags", "Tags", tags, { optional: true, hint: "separate them with commas, up to 5." }),
      field("author", "Author", author, { optional: true }),
      field("category", "Category", category, { optional: true }),
      field("source_url", "Source code link", sourceUrl, { optional: true, hint: "a github link lets people read the code inside Branch." }),
      h("div", { class: "field" }, h("label", { class: "inline-check", for: "ed-visible" }, visible, h("span", null, "show this mod on Branch (turn off to hide it without deleting it)"))),
      formError,
      h("div", { class: "ed-actions" }, save, h("a", { class: "btn btn-quiet", href: `#/mod/${encodeURIComponent(mod.slug)}` }, "View page")),
    );

    form.addEventListener("input", (e) => {
      const error = e.target.closest("[data-field]")?.querySelector(".error");
      if (error) error.hidden = true;
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      for (const err of form.querySelectorAll(".error")) err.hidden = true;
      formError.hidden = true;
      const local = {};
      if (name.value.trim().length < 2) local.name = "give your mod a name";
      if (description.value.trim().length < MIN_DESCRIPTION) local.description = `describe what your mod does (at least ${MIN_DESCRIPTION} characters)`;
      if (media.check()) local.video_url = media.check();
      if (Object.keys(local).length) return showErrors(form, local, formError);

      const data = new FormData();
      data.append("key", forumKey());
      data.append("name", name.value.trim());
      data.append("description", description.value.trim());
      data.append("author", author.value.trim());
      data.append("tags", tags.value.trim());
      data.append("category", category.value);
      data.append("source_url", sourceUrl.value.trim());
      data.append("status", visible.checked ? "published" : "unpublished");
      data.append("remove_thumbnail", removeThumb ? "true" : "false");
      if (newThumb) data.append("thumbnail", newThumb, "thumbnail.jpg");
      media.append(data);
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await uploadForm(`/api/creator/mods/${encodeURIComponent(mod.slug)}/edit`, data);
        toast("Your changes are live", { tone: "ok" });
        load();
      } catch (err) {
        if (err.fields) showErrors(form, err.fields, formError);
        else {
          formError.replaceChildren(icon("alert"), h("p", null, err.message));
          formError.hidden = false;
        }
        save.disabled = false;
        save.textContent = "Save changes";
      }
    });
    return form;
  }

  function releaseForm(mod) {
    let chosen = null;
    const fileInput = h("input", { type: "file", accept: ".dll,.zip", class: "visually-hidden", id: "ed-file", tabindex: "-1" });
    const fileLabel = h("span", { class: "file-chosen muted" }, "no file chosen");
    fileInput.addEventListener("change", () => {
      chosen = fileInput.files?.[0] || null;
      fileLabel.textContent = chosen ? `${chosen.name} · ${formatBytes(chosen.size)}` : "no file chosen";
      fileLabel.classList.toggle("muted", !chosen);
    });
    const version = h("input", { class: "input", maxlength: "40", autocomplete: "off", placeholder: "e.g. 1.1.0" });
    const changelog = h("textarea", { class: "textarea", rows: "4", maxlength: "4000", placeholder: "what's new in this version?" });
    const formError = h("div", { class: "banner danger compact", role: "alert", hidden: true });
    const submit = h("button", { class: "btn btn-primary", type: "submit" }, icon("upload"), "Post new version");
    const form = h(
      "form",
      { class: "form-card", novalidate: true, id: "ed-release" },
      h("h2", null, "Post a new version"),
      h("p", { class: "muted" }, mod.latest_version ? `the current version is ${mod.latest_version}. ` : "", "the new file goes through Branch's safety check, then becomes the main download."),
      h(
        "div",
        { class: "field", dataset: { field: "file" } },
        h("span", { class: "field-label" }, "Mod file"),
        h("div", { class: "file-row" }, h("button", { class: "btn", type: "button", onclick: () => fileInput.click() }, icon("upload"), "Choose file"), fileLabel, fileInput),
        h("p", { class: "error", hidden: true }),
      ),
      field("version", "Version", version, { optional: true }),
      field("changelog", "What's new", changelog, { optional: true }),
      formError,
      h("div", null, submit),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      for (const err of form.querySelectorAll(".error")) err.hidden = true;
      formError.hidden = true;
      if (!chosen) return showErrors(form, { file: "choose the new .dll or .zip file" }, formError);
      if (chosen.size > 50 * 1024 * 1024) return showErrors(form, { file: "files can be up to 50 MB" }, formError);
      const data = new FormData();
      data.append("key", forumKey());
      data.append("version", version.value.trim());
      data.append("changelog", changelog.value.trim());
      data.append("file", chosen, chosen.name);
      submit.disabled = true;
      try {
        const result = await uploadForm(`/api/creator/mods/${encodeURIComponent(mod.slug)}/release`, data);
        toast(`Version ${result.version} is live`, { tone: "ok" });
        load();
      } catch (err) {
        if (err.fields) showErrors(form, err.fields, formError);
        else {
          formError.replaceChildren(icon("alert"), h("p", null, err.message));
          formError.hidden = false;
        }
        submit.disabled = false;
      }
    });
    return form;
  }

  async function load() {
    const wanted = slug;
    clear(el).append(h("div", { class: "skeleton sk-title-lg" }), h("div", { class: "skeleton sk-line" }));
    try {
      const me = await myAccount(true);
      if (wanted !== slug) return;
      if (!me.account) {
        clear(el).append(accountGate({ onDone: load }));
        return;
      }
      const mod = await api(`/api/creator/mods/${encodeURIComponent(slug)}/listing`, { method: "POST", body: { key: forumKey() } });
      if (wanted !== slug) return;
      title = `Edit ${mod.name}`;
      ctx.setTitle(title);
      clear(el).append(
        h(
          "header",
          { class: "page-head" },
          h("a", { class: "btn btn-quiet btn-small", href: "#/rewards?tab=mods" }, icon("back"), "My mods"),
          h("h1", { id: "edit-title" }, title),
          h("p", { class: "muted" }, mod.status === "published" ? "changes go live as soon as you save." : "this mod is hidden right now. turn on \"show this mod on Branch\" to list it again."),
        ),
        listingForm(mod),
        releaseForm(mod),
      );
    } catch (err) {
      if (wanted !== slug) return;
      if (err.status === 404) {
        clear(el).append(stateBlock({ iconName: "box", title: "You can't edit this mod", message: "you can only edit mods you uploaded while logged in to your creator account.", actions: [ctx.link("#/rewards?tab=mods", "My mods")] }));
      } else {
        clear(el).append(errorBlock(err, load));
      }
    }
  }

  return {
    el,
    title: () => title,
    show(route) {
      slug = route.slug;
      title = "Edit mod";
      load();
      return 0;
    },
    hide() {},
  };
}
