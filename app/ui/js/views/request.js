// "request a mod": anyone can suggest a mod. it goes privately to the admin, who accepts or denies it.
import { h, clear } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../platform.js";
import { stateBlock } from "../ui.js";

export function createRequestView() {
  const el = h("section", { class: "view page", "aria-labelledby": "request-title" });

  function field(id, label, control, { hint, required } = {}) {
    control.id = id;
    if (hint) control.setAttribute("aria-describedby", `${id}-hint ${id}-error`);
    return h(
      "div",
      { class: "field", dataset: { field: id.replace("req-", "") } },
      h("label", { for: id }, label, required ? h("span", { class: "req", "aria-hidden": "true" }, "*") : h("span", { class: "muted" }, " (optional)")),
      control,
      hint ? h("p", { class: "hint", id: `${id}-hint` }, hint) : null,
      h("p", { class: "error", id: `${id}-error`, hidden: true }),
    );
  }

  function render() {
    const name = h("input", { class: "input", maxlength: "80", autocomplete: "off", required: true });
    const url = h("input", { class: "input", type: "url", maxlength: "500", placeholder: "https://github.com/…", autocomplete: "off", required: true });
    const author = h("input", { class: "input", maxlength: "80", autocomplete: "off" });
    const details = h("textarea", { class: "textarea", maxlength: "1000", rows: "4" });
    const contact = h("input", { class: "input", maxlength: "200", autocomplete: "off" });
    const trap = h("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    const formError = h("div", { class: "banner danger compact", role: "alert", hidden: true });
    const submit = h("button", { class: "btn btn-primary btn-large", type: "submit" }, "Send request");

    const form = h(
      "form",
      { class: "form-card", novalidate: true },
      field("req-mod_name", "Mod name", name, { required: true }),
      field("req-url", "Link to the mod", url, { required: true, hint: "its github page or the author's download page, so the admin can check it out." }),
      field("req-author", "Who made it", author),
      field("req-details", "Why should it be on Branch?", details, { hint: "what does it do? is it working on the current update?" }),
      field("req-contact", "Contact", contact, { hint: "only if you want a reply, like a discord name or email. only the admin sees it. if you're under 13, leave this empty." }),
      h("div", { class: "trap", "aria-hidden": "true" }, trap),
      formError,
      h("div", null, submit),
    );

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      for (const e of form.querySelectorAll(".error")) e.hidden = true;
      for (const e of form.querySelectorAll("[aria-invalid]")) e.removeAttribute("aria-invalid");
      formError.hidden = true;

      const local = {};
      if (!name.value.trim()) local.mod_name = "what's the mod called?";
      if (!url.value.trim()) local.url = "add a link to the mod, like its github page";
      if (Object.keys(local).length) return showErrors(local);

      submit.disabled = true;
      submit.textContent = "Sending…";
      try {
        await api("/api/requests", { method: "POST", body: { mod_name: name.value, url: url.value, author: author.value, details: details.value, contact: contact.value, website: trap.value } });
        clear(el).append(
          stateBlock({
            iconName: "check",
            title: "Request sent",
            message: "thanks! the Branch admin will take a look. if it gets added, it'll show up in the mod list.",
            actions: [h("button", { class: "btn", type: "button", onclick: render }, "Request another"), h("a", { class: "btn btn-primary", href: "#/browse" }, "Browse mods")],
          }),
        );
      } catch (err) {
        if (err.fields) showErrors(err.fields);
        else {
          formError.replaceChildren(icon("alert"), h("p", null, err.message));
          formError.hidden = false;
        }
        submit.disabled = false;
        submit.textContent = "Send request";
      }
    });

    function showErrors(fields) {
      let first = null;
      for (const [key, message] of Object.entries(fields)) {
        const wrap = form.querySelector(`[data-field="${key}"]`);
        if (!wrap) continue;
        const error = wrap.querySelector(".error");
        error.textContent = message;
        error.hidden = false;
        const control = wrap.querySelector("input, textarea");
        control.setAttribute("aria-invalid", "true");
        first = first || control;
      }
      first?.focus();
    }

    clear(el).append(
      h(
        "header",
        { class: "page-intro" },
        h("h1", { class: "view-title", id: "request-title" }, "Request a mod"),
        h("p", null, "know a mod that should be on Branch? send it in. the admin checks every request, and only adds mods that are allowed to be shared."),
      ),
      form,
    );
  }

  return { el, title: () => "Request a mod", show() { render(); return 0; }, hide() {} };
}
