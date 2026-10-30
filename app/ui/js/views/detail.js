// the page for a single mod.
import { h, clear, formatDate, formatBytes, formatNumber, hostOf } from "../dom.js";
import { icon } from "../icons.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { api, assetUrl, downloadRelease, cancelDownload, revealFile, canRevealFiles, openExternal, outboundUrl, isDesktop, githubFetch } from "../platform.js";
import { openSourceViewer, parseGithub } from "../../shared/source-viewer.js";
import { favorites, recent, changes } from "../store.js";
import { compatBadge, errorBlock, stateBlock, thumbnail, toast, showCompatHelp } from "../ui.js";
import { openReportDialog } from "./report.js";
import { versionLabel } from "./browse.js";

const PLATFORM_LABELS = { steam: "Steam (PC VR)", oculus_pc: "Meta / Oculus PC (PC VR)", quest: "Quest standalone" };
const REDISTRIBUTION_TEXT = {
  allowed: "the author allows copies to be shared, so Branch can host the file.",
  not_allowed: "the author doesn't allow copies to be shared. Branch only links to the original release.",
  unknown: "Branch doesn't know if copies can be shared, so it links to the original release instead of hosting a copy.",
};

export function createDetailView(ctx) {
  const el = h("section", { class: "view detail" });
  let currentSlug = null;
  let currentMod = null;
  let requestId = 0;
  // downloads keep going if you leave the page, so their state lives out here
  const downloads = new Map();
  const downloadSlots = new Map();

  function skeleton() {
    return h(
      "div",
      { class: "detail-skeleton", "aria-busy": "true", "aria-label": "Loading mod" },
      h("div", { class: "skeleton sk-hero" }),
      h("div", { class: "sk-hero-text" }, h("div", { class: "skeleton sk-title-lg" }), h("div", { class: "skeleton sk-line" }), h("div", { class: "skeleton sk-line short" }), h("div", { class: "skeleton sk-button" })),
    );
  }

  async function load(slug) {
    const id = ++requestId;
    currentSlug = slug;
    clear(el).append(skeleton());
    try {
      const mod = await api(`/api/mods/${encodeURIComponent(slug)}`);
      if (id !== requestId) return;
      currentMod = mod;
      recent.add(mod.slug);
      ctx.setTitle(mod.name);
      clear(el).append(render(mod));
    } catch (err) {
      if (id !== requestId) return;
      currentMod = null;
      if (err.status === 404) {
        clear(el).append(
          stateBlock({
            iconName: "box",
            title: "This mod isn't available",
            message: "it might have been taken down or renamed. it's no longer listed on Branch.",
            actions: [ctx.link("#/browse", "Browse mods")],
          }),
        );
      } else {
        clear(el).append(errorBlock(err, () => load(slug)));
      }
    }
  }

  function render(mod) {
    const latest = mod.releases[0] || null;
    const compatInfo = ctx.meta?.compatibility?.find((c) => c.key === mod.compatibility.status);

    const favButton = h("button", { class: "btn", type: "button", "aria-pressed": "false" });
    const syncFav = () => {
      const on = favorites.has(mod.slug);
      favButton.setAttribute("aria-pressed", String(on));
      favButton.replaceChildren(icon(on ? "starFill" : "star"), on ? "Favorited" : "Favorite");
      favButton.classList.toggle("is-on", on);
    };
    favButton.addEventListener("click", () => {
      const on = favorites.toggle(mod.slug);
      toast(on ? "Added to favorites" : "Removed from favorites", { tone: on ? "ok" : "neutral" });
    });
    syncFav();
    const favListener = () => syncFav();
    changes.addEventListener("favorites", favListener);
    // stop listening once this page is replaced
    queueMicrotask(() => {
      const observer = new MutationObserver(() => {
        if (!el.contains(favButton)) { changes.removeEventListener("favorites", favListener); observer.disconnect(); }
      });
      observer.observe(el, { childList: true });
    });

    const reportButton = h("button", { class: "btn btn-quiet", type: "button", onclick: () => openReportDialog(ctx, mod) }, icon("flag"), "Report");
    // only shown when the mod has a github source link
    const sourceButton = parseGithub(mod.source_url || "")
      ? h("button", { class: "btn btn-quiet", type: "button", onclick: () => openSourceViewer(mod.source_url, { fetchJson: githubFetch, openLink: (u) => openExternal(u) }) }, icon("code"), "View source code")
      : null;

    const head = h(
      "header",
      { class: "detail-head" },
      h("div", { class: "hero-media" }, thumbnail(mod.thumbnail_url, "hero-img")),
      h(
        "div",
        { class: "hero-info" },
        mod.category ? h("a", { class: "eyebrow", href: `#/browse?category=${encodeURIComponent(mod.category.slug)}` }, mod.category.name) : null,
        h("h1", { class: "detail-title" }, mod.name),
        h("p", { class: "byline" }, "by ", mod.author.url ? externalLink(mod.author.url, mod.author.name || "unknown author") : mod.author.name || "unknown author"),
        mod.summary ? h("p", { class: "detail-summary" }, mod.summary) : null,
        h(
          "div",
          { class: "hero-facts" },
          h("button", { class: "badge-button", type: "button", title: "What this means", onclick: () => showCompatHelp(ctx.meta) }, compatBadge(mod.compatibility.status, ctx.meta)),
          latest ? h("span", null, `Version ${latest.version}`) : null,
          latest ? h("span", null, `Released ${formatDate(latest.released_on)}`) : null,
        ),
        downloadArea(mod, latest),
        h("div", { class: "hero-secondary" }, favButton, sourceButton, reportButton),
      ),
    );

    const warnings = h(
      "div",
      { class: "detail-warnings" },
      mod.community
        ? h(
            "div",
            { class: "banner info" },
            icon("info"),
            h("div", null, h("strong", null, "Community upload"), h("p", null, "someone in the community uploaded this mod. Branch only checked it automatically, so be extra careful and use the mod checker or the source code if you're unsure.")),
          )
        : null,
      compatWarning(mod, compatInfo),
    );

    const main = h(
      "div",
      { class: "detail-main" },
      mod.screenshots.length ? section("Screenshots", gallery(mod)) : null,
      section("About this mod", mod.description ? markdown(mod.description) : h("p", { class: "muted" }, "the author hasn't added a full description.")),
      section(
        "How to install",
        mod.install_instructions ? markdown(mod.install_instructions) : h("p", { class: "muted" }, "no install steps were added for this mod. check the original project page for instructions."),
        h(
          "div",
          { class: "safety-note" },
          icon("shield"),
          h("p", null, "Branch only downloads the file. it never installs or runs anything for you. back up your game folder first, and only use files you trust."),
        ),
      ),
      mod.releases.length ? section("Changelog", changelog(mod.releases)) : null,
      mod.known_issues ? section("Known issues", markdown(mod.known_issues)) : null,
    );

    const side = h("aside", { class: "detail-side", "aria-label": "Mod details" }, detailsCard(mod, latest), requirementsCard(mod), fileCard(latest), licenseCard(mod), linksCard(mod), tagsCard(mod));

    return h("article", { class: "detail-page", "aria-labelledby": "detail-title" }, warnings, head, h("div", { class: "detail-body" }, main, side));
  }

  function compatWarning(mod, info) {
    const status = mod.compatibility.status;
    const extra = [mod.compatibility.note, mod.compatibility.checked_on ? `last checked ${formatDate(mod.compatibility.checked_on)}.` : null].filter(Boolean).join(" ");
    if (status === "tested") {
      return null;
    }
    const tone = status === "broken" ? "danger" : status === "outdated" ? "warn" : "info";
    const titles = { broken: "Marked as broken", outdated: "Marked as outdated", unconfirmed: "Compatibility not confirmed" };
    return h(
      "div",
      { class: `banner ${tone}`, role: status === "unconfirmed" ? null : "alert" },
      icon(status === "unconfirmed" ? "info" : "alert"),
      h("div", null, h("strong", null, titles[status] || "Compatibility"), h("p", null, [info?.description, extra].filter(Boolean).join(" "))),
    );
  }

  function downloadArea(mod, release) {
    const area = h("div", { class: "download-area" });
    if (!release) {
      area.append(h("button", { class: "btn btn-primary btn-large", type: "button", disabled: true }, icon("download"), "No download yet"), h("p", { class: "download-note" }, "the Branch admin hasn't added a release for this mod yet."));
      return area;
    }
    if (!release.available) {
      area.append(
        h("button", { class: "btn btn-primary btn-large", type: "button", disabled: true }, icon("download"), "Download unavailable"),
        h("div", { class: "banner danger compact", role: "note" }, icon("alert"), h("p", null, release.disabled_reason ? `the download was turned off: ${release.disabled_reason}` : "the download for this version was turned off by the Branch admin.")),
      );
      return area;
    }
    if (release.kind === "external") {
      const host = release.external_host || hostOf(release.external_url);
      area.append(
        h("button", { class: "btn btn-primary btn-large", type: "button", onclick: () => openExternal(outboundUrl(release.id)).catch(() => toast("couldn't open your browser", { tone: "error" })) }, icon("external"), `Get it from ${host}`),
        h("p", { class: "download-note" }, `opens the author's release page in your browser. Branch doesn't host a copy of this file.`),
      );
      return area;
    }
    const status = h("div", { class: "download-status", "aria-live": "polite" });
    const button = h("button", { class: "btn btn-primary btn-large", type: "button" }, icon("download"), /^\d/.test(versionLabel(release.version).replace(/^v/, "")) ? `Download ${versionLabel(release.version)}` : "Download");
    const fileBits = [release.file?.type ? `.${release.file.type} file` : null, release.file ? formatBytes(release.file.size) : null].filter(Boolean).join(", ");
    area.append(button, h("p", { class: "download-note" }, `direct download from Branch${fileBits ? ` (${fileBits})` : ""}. you pick where it's saved.`), status);
    // the page can be rebuilt while a download runs, so progress always paints
    // into whichever button and status area are on screen right now
    downloadSlots.set(release.id, { button, status, retry: () => startDownload(mod, release) });
    button.addEventListener("click", () => startDownload(mod, release));
    repaintDownload(release.id);
    return area;
  }

  function repaintDownload(key) {
    const slot = downloadSlots.get(key);
    if (slot) paintDownload(key, slot.button, slot.status, slot.retry);
  }

  async function startDownload(mod, release) {
    const key = release.id;
    const existing = downloads.get(key);
    if (existing?.state === "downloading") return;
    const job = { state: "downloading", received: 0, total: release.file?.size ?? null, path: null, error: null, id: `${key}-${Date.now()}` };
    downloads.set(key, job);
    const repaint = () => repaintDownload(key);
    repaint();
    try {
      const result = await downloadRelease(
        { id: job.id, releaseId: release.id, fileName: release.file?.name || `${mod.slug}-${release.version}`, sha256: release.file?.sha256 },
        (received, total) => {
          job.received = received;
          if (total) job.total = total;
          repaint();
        },
      );
      if (result.status === "cancelled") {
        downloads.delete(key);
        toast("Download cancelled");
      } else {
        job.state = "done";
        job.path = result.path;
        toast(`Saved ${release.file?.name || "the file"}`, { tone: "ok" });
      }
    } catch (err) {
      job.state = "error";
      job.error = err.message;
    }
    repaint();
  }

  function paintDownload(key, button, status, retry) {
    if (!status.isConnected && !button.isConnected) return;
    const job = downloads.get(key);
    clear(status);
    button.disabled = job?.state === "downloading";
    if (!job) return;

    if (job.state === "downloading") {
      const pct = job.total ? Math.min(100, Math.round((job.received / job.total) * 100)) : null;
      const bar = h("div", { class: "progress", role: "progressbar", "aria-label": "Download progress", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct ?? null });
      const fill = h("div", { class: `progress-fill${pct == null ? " indeterminate" : ""}` });
      if (pct != null) fill.style.width = `${pct}%`;
      bar.append(fill);
      status.append(
        h("div", { class: "download-row" }, bar, h("button", { class: "btn btn-quiet", type: "button", onclick: () => cancelDownload(job.id) }, "Cancel")),
        h("p", { class: "download-note" }, job.total ? `${formatBytes(job.received)} of ${formatBytes(job.total)}` : job.received ? `${formatBytes(job.received)} so far` : "waiting for the save location…"),
      );
    } else if (job.state === "done") {
      status.append(
        h(
          "div",
          { class: "banner ok compact" },
          icon("check"),
          h("p", null, job.path ? `Saved to ${job.path}` : "Download finished."),
          canRevealFiles && job.path ? h("button", { class: "btn", type: "button", onclick: () => revealFile(job.path).catch(() => toast("couldn't open the folder", { tone: "error" })) }, icon("folder"), "Show in folder") : null,
        ),
      );
    } else if (job.state === "error") {
      status.append(h("div", { class: "banner danger compact", role: "alert" }, icon("alert"), h("p", null, job.error || "the download failed."), h("button", { class: "btn", type: "button", onclick: retry }, icon("refresh"), "Try again")));
    }
  }

  function gallery(mod) {
    const strip = h("div", { class: "gallery", role: "list" });
    mod.screenshots.forEach((shot, index) => {
      strip.append(
        h(
          "button",
          { class: "gallery-item", type: "button", role: "listitem", "aria-label": `Open screenshot ${index + 1}${shot.caption ? `: ${shot.caption}` : ""}`, onclick: () => openLightbox(mod.screenshots, index) },
          h("img", { src: assetUrl(shot.url), alt: shot.caption || "", loading: "lazy" }),
        ),
      );
    });
    return strip;
  }

  function openLightbox(shots, start) {
    let index = start;
    const img = h("img", { class: "lightbox-img", alt: "" });
    const caption = h("p", { class: "lightbox-caption" });
    const prev = h("button", { class: "icon-btn", type: "button", "aria-label": "Previous screenshot" }, icon("chevronLeft"));
    const next = h("button", { class: "icon-btn", type: "button", "aria-label": "Next screenshot" }, icon("chevronRight"));
    const close = h("button", { class: "icon-btn lightbox-close", type: "button", "aria-label": "Close" }, icon("close"));
    const dialog = h("dialog", { class: "lightbox", "aria-label": "Screenshots" }, close, h("div", { class: "lightbox-stage" }, prev, img, next), caption);
    const show = () => {
      img.src = assetUrl(shots[index].url);
      img.alt = shots[index].caption || `screenshot ${index + 1}`;
      caption.textContent = `${index + 1} of ${shots.length}${shots[index].caption ? `  ·  ${shots[index].caption}` : ""}`;
      prev.disabled = index === 0;
      next.disabled = index === shots.length - 1;
    };
    prev.addEventListener("click", () => { if (index > 0) { index--; show(); } });
    next.addEventListener("click", () => { if (index < shots.length - 1) { index++; show(); } });
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") prev.click();
      if (e.key === "ArrowRight") next.click();
    });
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    show();
    dialog.showModal();
  }

  function changelog(releases) {
    return h(
      "ol",
      { class: "changelog", role: "list" },
      releases.map((r) =>
        h(
          "li",
          null,
          h("div", { class: "changelog-head" }, h("strong", null, r.version), h("span", { class: "muted" }, formatDate(r.released_on)), r.game_version ? h("span", { class: "muted" }, `game ${r.game_version}`) : null, !r.available ? h("span", { class: "badge broken" }, "Download off") : null),
          r.changelog ? markdown(r.changelog) : h("p", { class: "muted" }, "no notes for this version."),
        ),
      ),
    );
  }

  function detailsCard(mod, latest) {
    const rows = [
      ["Version", latest?.version],
      ["Released", latest ? formatDate(latest.released_on) : null],
      ["Game versions", mod.game_versions],
      ["Platforms", mod.platforms.map((p) => PLATFORM_LABELS[p] || p).join(", ")],
      ["Mod loader", mod.mod_loader],
      ["Category", mod.category?.name],
      ["Downloads", mod.downloads ? h("span", { title: "times this mod was downloaded or opened through Branch. each person counts once a day." }, formatNumber(mod.downloads)) : null],
    ];
    return card("Details", infoList(rows), rows.every(([, v]) => !v) ? h("p", { class: "muted" }, "no details were added.") : null);
  }

  function requirementsCard(mod) {
    if (!mod.dependencies.length) return null;
    return card(
      "Requirements",
      h(
        "ul",
        { class: "dep-list", role: "list" },
        mod.dependencies.map((d) => h("li", null, d.url ? externalLink(d.url, d.name) : d.name, h("span", { class: "muted" }, d.required ? " required" : " optional"))),
      ),
    );
  }

  function fileCard(release) {
    if (!release || release.kind !== "hosted" || !release.file) return null;
    const copy = h("button", { class: "icon-btn small", type: "button", "aria-label": "Copy SHA-256 checksum", title: "Copy checksum" }, icon("copy"));
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(release.file.sha256);
        toast("Checksum copied", { tone: "ok" });
      } catch {
        toast("couldn't copy. select the text instead.", { tone: "error" });
      }
    });
    return card(
      "File",
      infoList([
        ["Name", release.file.name],
        ["Type", release.file.type ? `.${release.file.type}` : null],
        ["Size", formatBytes(release.file.size)],
      ]),
      release.file.sha256 ? h("div", { class: "checksum" }, h("span", { class: "muted" }, "SHA-256"), copy, h("code", null, release.file.sha256)) : null,
      isDesktop ? h("p", { class: "muted small" }, "Branch checks the checksum after downloading.") : null,
    );
  }

  function licenseCard(mod) {
    const license = mod.license.name ? (mod.license.url ? externalLink(mod.license.url, mod.license.name) : mod.license.name) : "not listed";
    return card("License", h("p", null, license), h("p", { class: "muted small" }, REDISTRIBUTION_TEXT[mod.redistribution] || ""), mod.redistribution_note ? h("p", { class: "muted small" }, mod.redistribution_note) : null);
  }

  function linksCard(mod) {
    const links = [
      mod.source_url ? ["Source code", mod.source_url] : null,
      mod.project_url ? ["Original project", mod.project_url] : null,
    ].filter(Boolean);
    if (!links.length) return card("Links", h("p", { class: "muted" }, "no source or project links were added."));
    return card("Links", h("ul", { class: "link-list", role: "list" }, links.map(([label, url]) => h("li", null, externalLink(url, label), h("span", { class: "muted small" }, hostOf(url))))));
  }

  function tagsCard(mod) {
    if (!mod.tags.length) return null;
    return card("Tags", h("div", { class: "chips" }, mod.tags.map((t) => h("span", { class: "chip" }, t))));
  }

  function card(title, ...content) {
    return h("section", { class: "side-card" }, h("h2", null, title), ...content);
  }

  function infoList(rows) {
    return h("dl", { class: "info-list" }, rows.filter(([, v]) => v).map(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  }

  function section(title, ...content) {
    return h("section", { class: "detail-section" }, h("h2", null, title), ...content);
  }

  function markdown(text) {
    return h("div", { class: "prose", html: renderMarkdown(text) });
  }

  function externalLink(url, label) {
    return h("a", { href: url, "data-external": true, title: `Opens ${hostOf(url)} in your browser` }, label, icon("external", "inline-icon"));
  }

  return {
    el,
    title: () => currentMod?.name || "Mod",
    show(params) {
      if (params.slug !== currentSlug || !currentMod) load(params.slug);
      else {
        recent.add(currentMod.slug);
        ctx.setTitle(currentMod.name);
      }
      return 0;
    },
    hide() {},
  };
}
