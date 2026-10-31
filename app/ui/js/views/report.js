import { h, clear } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../platform.js";
import { forumKey } from "../forum-identity.js";

const FALLBACK_REASONS = [
  { key: "broken_download", label: "Broken download" },
  { key: "outdated", label: "Outdated or incompatible" },
  { key: "misleading", label: "Misleading information" },
  { key: "harmful", label: "Suspicious or harmful file" },
  { key: "copyright", label: "Copyright or permission issue" },
  { key: "other", label: "Other" },
];

export function openReportDialog(ctx, mod) {
  const reasons = ctx.meta?.report_reasons?.length ? ctx.meta.report_reasons : FALLBACK_REASONS;

  const reasonError = h("p", { class: "error", id: "report-reason-error", hidden: true });
  const reasonGroup = h(
    "fieldset",
    { class: "reason-group", "aria-describedby": "report-reason-error" },
    h("legend", { class: "field-label" }, "What's wrong?", h("span", { class: "req", "aria-hidden": "true" }, "*")),
    reasons.map((r) =>
      h("label", { class: "reason" }, h("input", { type: "radio", name: "reason", value: r.key, required: true }), h("span", null, r.label)),
    ),
    reasonError,
  );

  const details = h("textarea", { class: "textarea", id: "report-details", maxlength: "2000", rows: "4", "aria-describedby": "report-details-hint report-details-error" });
  const detailsError = h("p", { class: "error", id: "report-details-error", hidden: true });
  const contact = h("input", { class: "input", id: "report-contact", maxlength: "200", autocomplete: "off", "aria-describedby": "report-contact-hint" });
  const trap = h("input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });

  const formError = h("div", { class: "banner danger compact", role: "alert", hidden: true });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Send report");
  const cancel = h("button", { class: "btn", type: "button" }, "Cancel");

  const body = h(
    "div",
    { class: "sheet-body" },
    h("div", null, h("h2", { class: "sheet-title", id: "report-title" }, `Report ${mod.name}`), h("p", { class: "muted" }, "reports go privately to the Branch admin. nothing you write here is shown publicly.")),
    reasonGroup,
    h(
      "div",
      { class: "field" },
      h("label", { for: "report-details" }, "Details ", h("span", { class: "muted" }, "(optional)")),
      details,
      h("p", { class: "hint", id: "report-details-hint" }, "what happened? for example: \"the download link goes to a 404 page\"."),
      detailsError,
    ),
    h(
      "div",
      { class: "field" },
      h("label", { for: "report-contact" }, "Contact ", h("span", { class: "muted" }, "(optional)")),
      contact,
      h("p", { class: "hint", id: "report-contact-hint" }, "only add this if you want a reply, like a discord name or email. it's only seen by the admin. if you're under 13, leave this empty."),
    ),
    h("div", { class: "trap", "aria-hidden": "true" }, trap),
    formError,
  );

  const form = h("form", { method: "dialog", novalidate: true }, body, h("div", { class: "sheet-actions" }, cancel, submit));
  const dialog = h("dialog", { class: "sheet", "aria-labelledby": "report-title" }, form);

  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const reason = form.querySelector("input[name=reason]:checked")?.value;
    reasonError.hidden = true;
    detailsError.hidden = true;
    formError.hidden = true;
    details.removeAttribute("aria-invalid");

    if (!reason) {
      reasonError.textContent = "pick the reason that fits best.";
      reasonError.hidden = false;
      form.querySelector("input[name=reason]").focus();
      return;
    }
    if (reason === "other" && !details.value.trim()) {
      detailsError.textContent = "tell the admin a little about the problem.";
      detailsError.hidden = false;
      details.setAttribute("aria-invalid", "true");
      details.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = "Sending…";
    try {
      await api("/api/reports", {
        method: "POST",
        body: { mod_slug: mod.slug, reason, details: details.value.trim(), contact: contact.value.trim(), website: trap.value, key: forumKey() },
      });
      clear(dialog).append(
        h(
          "div",
          { class: "sheet-body center" },
          h("div", { class: "state-icon ok" }, icon("check")),
          h("h2", { class: "sheet-title", id: "report-title" }, "Report sent"),
          h("p", { class: "muted" }, "thanks. the Branch admin will look at it, and you can follow it and see any reply in your Inbox."),
        ),
        h("div", { class: "sheet-actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => dialog.close(), autofocus: true }, "Done")),
      );
      dialog.querySelector("button").focus();
    } catch (err) {
      const fieldMessage = err.fields && Object.values(err.fields)[0];
      formError.replaceChildren(icon("alert"), h("p", null, fieldMessage || err.message || "the report couldn't be sent. try again in a minute."));
      formError.hidden = false;
      submit.disabled = false;
      submit.textContent = "Send report";
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  reasonGroup.querySelector("input").focus();
}
