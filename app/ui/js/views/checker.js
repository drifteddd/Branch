import { h, clear, formatBytes } from "../dom.js";
import { icon } from "../icons.js";
import { api, uploadForm, aiOff } from "../platform.js";
import { settings } from "../store.js";

const STEPS = ["Reading the file", "Looking inside", "Checking for warning signs", "Asking the AI"];

export function createCheckerView() {
  const el = h("section", { class: "view page checker", "aria-labelledby": "checker-title" });
  const usage = h("p", { class: "usage", "aria-live": "polite" });
  const body = h("div", { class: "checker-body" });
  let busy = false;

  async function loadUsage() {
    try {
      const u = await api("/api/check/usage");
      setUsage(u.remaining, u.limit);
    } catch {
      usage.textContent = "";
    }
  }

  function setUsage(remaining, limit) {
    usage.textContent = `${remaining} of ${limit} checks left today`;
  }

  function renderPicker(message) {
    const input = h("input", { type: "file", accept: ".dll,.zip", class: "visually-hidden", id: "checker-file", tabindex: "-1" });
    const choose = h("button", { class: "btn btn-primary btn-large", type: "button", onclick: () => input.click() }, icon("upload"), "Choose a mod file");
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) run(file);
    });
    clear(body).append(
      h(
        "div",
        { class: "drop-card" },
        h("div", { class: "drop-icon" }, icon("shield")),
        h("p", { class: "drop-title" }, "Check a mod before you use it"),
        h("p", { class: "muted" }, ".dll or .zip, up to 50 MB. the file is only read, never run, and it isn't saved."),
        choose,
        input,
      ),
      message ? h("div", { class: "banner danger compact", role: "alert" }, icon("alert"), h("p", null, message)) : null,
    );
  }

  async function run(file) {
    if (busy || !file) return;
    if (file.size === 0) return renderPicker("that file is empty.");
    if (file.size > 50 * 1024 * 1024) return renderPicker("files can be up to 50 MB.");
    busy = true;
    const step = h("p", { class: "scan-step" }, STEPS[0]);
    const progress = h("div", { class: "progress" }, h("div", { class: "progress-fill indeterminate" }));
    let i = 0;
    const timer = setInterval(() => { i = Math.min(i + 1, STEPS.length - 1); step.textContent = STEPS[i]; }, 900);
    clear(body).append(h("div", { class: "drop-card scanning", "aria-busy": "true" }, h("div", { class: "drop-icon pulse" }, icon("shield")), h("p", { class: "drop-title" }, `Checking ${file.name}…`), progress, step));
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const result = await uploadForm("/api/check", form);
      setUsage(result.remaining, result.limit);
      renderResult(result);
    } catch (err) {
      renderPicker(err.fields?.file || err.message);
    } finally {
      clearInterval(timer);
      busy = false;
    }
  }
  function renderResult(r) {
    const tone = r.score <= 20 ? "clean" : r.score <= 45 ? "odd" : r.score <= 70 ? "suspicious" : "danger";
    const number = h("span", { class: "meter-number" }, "0");
    const fill = h("div", { class: "meter-fill" });
    const marker = h("div", { class: "meter-marker" });
    const meter = h(
      "div",
      { class: "meter", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(r.score), "aria-label": `Suspicion ${r.score} out of 100: ${r.verdict}` },
      h("div", { class: "meter-track" }, fill, marker),
      h("div", { class: "meter-scale", "aria-hidden": "true" }, h("span", null, "clean"), h("span", null, "suspicious"), h("span", null, "malicious")),
    );

    const signals = r.indicators?.length
      ? h(
          "details",
          { class: "signals" },
          h("summary", null, `What the basic scan spotted (${r.indicators.length})`),
          h("ul", null, r.indicators.map((i) => h("li", null, h("strong", null, i.label), i.evidence?.length ? h("code", null, i.evidence.join("  ·  ")) : null))),
        )
      : null;

    clear(body).append(
      h(
        "article",
        { class: `result-card ${tone}` },
        h(
          "div",
          { class: "result-head" },
          h("div", null, h("p", { class: "result-file" }, r.file.name), h("p", { class: "muted small" }, `${formatBytes(r.file.size)} · .${r.file.kind}${r.mod_markers?.length ? ` · uses ${r.mod_markers.join(", ")}` : ""}`)),
          h("div", { class: "score" }, number, h("span", { class: "score-of" }, "/100")),
        ),
        h(
          "div",
          { class: "verdict-row" },
          h("p", { class: "verdict" }, r.verdict),
          r.confidence ? h("span", { class: `confidence ${r.confidence}`, title: "how sure the check is, based on how much of the code it could read" }, `${r.confidence} confidence`) : null,
        ),
        meter,
        r.summary ? h("p", { class: "result-summary" }, r.summary) : null,
        r.what_it_does ? h("div", { class: "what-it-does" }, h("p", { class: "section-label" }, "What this mod seems to do"), h("p", null, r.what_it_does)) : null,
        r.capabilities?.length
          ? h(
              "div",
              null,
              h("p", { class: "section-label" }, "What the code can do"),
              h(
                "ul",
                { class: "capabilities" },
                r.capabilities.map((c) =>
                  h("li", { class: `cap ${c.level}` }, h("span", { class: "cap-dot", "aria-hidden": "true" }), h("span", { class: "cap-name" }, c.name), h("span", { class: "cap-level" }, c.level), c.detail ? h("span", { class: "cap-detail" }, c.detail) : null),
                ),
              ),
            )
          : null,
        r.reasons?.length ? h("div", null, h("p", { class: "section-label" }, "Why this score"), h("ul", { class: "reasons" }, r.reasons.map((x) => h("li", null, x)))) : null,
        r.code?.obfuscated ? h("p", { class: "muted small" }, "the code's names are scrambled (obfuscated), so the check could see less than usual.") : null,
        r.source === "basic" ? h("p", { class: "muted small" }, "the AI wasn't used for this one, so the score comes from Branch's basic scan.") : null,
        signals,
        h("p", { class: "fine-print" }, "this is an automated guess, not a guarantee. a low score doesn't prove a file is safe, and a high score doesn't prove it's a virus. cheats and game changes aren't counted as suspicious here, but they can still get you banned."),
        h("p", { class: "muted small checksum-line" }, "SHA-256 ", h("code", null, r.file.sha256)),
        h("div", null, h("button", { class: "btn", type: "button", onclick: () => renderPicker() }, "Check another file")),
      ),
    );
    animateMeter(r.score, fill, marker, number);
  }

  function animateMeter(score, fill, marker, number) {
    const reduce = settings.get().reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduce ? 0 : 1400;
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const frame = (now) => {
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      const value = score * ease(t);
      fill.style.width = `${value}%`;
      fill.style.backgroundSize = `${value > 0 ? 10000 / value : 100}% 100%`;
      marker.style.left = `${value}%`;
      number.textContent = String(Math.round(value));
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  const aiNote = h("p", { class: "banner info compact ai-off-note", hidden: true }, icon("info"), h("span", null, "Branch AI is off, so files get the basic scan only. it still catches the most obvious malware."));
  el.append(
    h(
      "header",
      { class: "page-intro" },
      h("h1", { class: "view-title", id: "checker-title" }, "Mod checker"),
      h("p", null, "upload a mod and Branch's AI looks for signs of viruses, password stealers and remote-access tools (RATs). it's free."),
      usage,
      aiNote,
    ),
    body,
  );

  return {
    el,
    title: () => "Mod checker",
    show() {
      aiNote.hidden = !aiOff();
      if (!busy && !body.querySelector(".result-card")) renderPicker();
      loadUsage();
      return 0;
    },
    hide() {},
  };
}
