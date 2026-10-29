// shows a public github repo's files inside branch, read straight from github's api.
// file contents are only ever put on the page as plain text, so nothing in a repo can run.

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function parseGithub(url) {
  try {
    const u = new URL(url);
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
    const [owner, repo, kind, ref, ...rest] = u.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    return { owner, repo: repo.replace(/\.git$/, ""), ref: kind === "tree" || kind === "blob" ? ref : null, path: rest.join("/") };
  } catch {
    return null;
  }
}

async function browserFetch(path) {
  let res;
  try {
    res = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json" } });
  } catch {
    throw new Error("couldn't reach github.");
  }
  if (res.status === 403 || res.status === 429) throw new Error("github's free limit (60 requests an hour) was hit. try again a bit later.");
  if (res.status === 404) throw new Error("github couldn't find that repo or file. it might be private or deleted.");
  if (!res.ok) throw new Error(`github answered with an error (${res.status}).`);
  return res.json();
}

/**
 * opens the viewer. returns false if the link isn't a github repo.
 * fetchJson(path) loads "https://api.github.com" + path. the desktop app passes its own.
 * openLink(url) opens a link outside (the desktop app uses the normal browser).
 */
export function openSourceViewer(url, { fetchJson = browserFetch, openLink = null } = {}) {
  const info = parseGithub(url || "");
  if (!info) return false;

  const repoUrl = `https://github.com/${info.owner}/${info.repo}`;
  const fileList = h("ul", { class: "sv-files", role: "list" });
  const filter = h("input", { class: "input", type: "search", placeholder: "Filter files", "aria-label": "Filter files" });
  const code = h("div", { class: "sv-code", tabindex: "0", "aria-label": "File contents" }, h("p", { class: "sv-note" }, "loading…"));
  const meta = h("p", { class: "sv-meta" });
  const githubLink = h("a", { class: "btn btn-quiet", href: repoUrl, target: "_blank", rel: "noopener noreferrer" }, "Open on GitHub");
  if (openLink) githubLink.addEventListener("click", (e) => { e.preventDefault(); openLink(repoUrl); });
  const close = h("button", { class: "btn btn-primary", type: "button" }, "Close");
  const dialog = h(
    "dialog",
    { class: "sheet source-viewer", "aria-label": `Source code of ${info.owner}/${info.repo}` },
    h("div", { class: "sv-head" }, h("div", { class: "sv-title" }, h("h2", { class: "sheet-title" }, `${info.owner}/${info.repo}`), meta), githubLink, close),
    h("div", { class: "sv-body" }, h("div", { class: "sv-side" }, filter, fileList), code),
  );
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();

  let files = [];
  let ref = info.ref;

  const showFile = async (path) => {
    for (const b of fileList.querySelectorAll("button")) b.setAttribute("aria-current", String(b.dataset.path === path));
    code.replaceChildren(h("p", { class: "sv-note" }, `loading ${path}…`));
    try {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const file = await fetchJson(`/repos/${info.owner}/${info.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
      if (!file.content || file.size > 1_000_000) {
        code.replaceChildren(h("p", { class: "sv-note" }, "this file is too big to show here. open it on github instead."));
        return;
      }
      const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0));
      if (bytes.includes(0)) {
        code.replaceChildren(h("p", { class: "sv-note" }, `${path} is a binary file (like a compiled .dll or an image), so it can't be shown as text.`));
        return;
      }
      const lines = new TextDecoder().decode(bytes).split("\n").slice(0, 5000);
      const pre = h("pre", { class: "sv-lines" });
      lines.forEach((line, i) => pre.append(h("span", { class: "ln" }, String(i + 1)), h("span", { class: "lc" }, line || " ")));
      code.replaceChildren(h("p", { class: "sv-path" }, path), pre);
    } catch (err) {
      code.replaceChildren(h("p", { class: "sv-error" }, err.message || "couldn't load this file."));
    }
  };

  const drawList = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = files.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 1500);
    fileList.replaceChildren(...shown.map((path) => h("li", null, h("button", { type: "button", dataset: { path }, title: path, onclick: () => showFile(path) }, path))));
  };
  filter.addEventListener("input", drawList);

  (async () => {
    try {
      const repo = await fetchJson(`/repos/${info.owner}/${info.repo}`);
      ref = ref || repo.default_branch;
      meta.textContent = [repo.description, `branch ${ref}`, repo.license?.spdx_id ? `license ${repo.license.spdx_id}` : "no license file", repo.archived ? "archived" : null].filter(Boolean).join(" · ");
      const tree = await fetchJson(`/repos/${info.owner}/${info.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      files = tree.tree.filter((t) => t.type === "blob").map((t) => t.path).sort();
      if (tree.truncated) meta.textContent += " · big repo, some files aren't listed";
      drawList();
      const start = (info.path && files.includes(info.path) && info.path) || files.find((p) => /^readme(\.md)?$/i.test(p)) || files.find((p) => p.endsWith(".cs")) || files[0];
      if (start) showFile(start);
      else code.replaceChildren(h("p", { class: "sv-note" }, "this repo has no files."));
    } catch (err) {
      code.replaceChildren(h("p", { class: "sv-error" }, err.message || "couldn't load this repo."));
    }
  })();

  return true;
}
