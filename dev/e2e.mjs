// clicks through the real interface in a headless browser against the demo server.
// it uses edge or chrome through the devtools protocol, so nothing has to be installed.
// run: node dev/e2e.mjs        (screenshots end up in dev/.screens/)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockServer } from "./mock-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const screens = join(here, ".screens");
mkdirSync(screens, { recursive: true });

const PORT = 5199;
const DEBUG_PORT = 9339;
const BASE = `http://127.0.0.1:${PORT}`;

const candidates = [
  process.env.BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);
const browserPath = candidates.find((p) => existsSync(p));
if (!browserPath) {
  console.error("no edge or chrome found. set BROWSER_PATH.");
  process.exit(1);
}

const server = await startMockServer(PORT);
const profile = mkdtempSync(join(tmpdir(), "branch-e2e-"));
const browser = spawn(browserPath, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,800",
  // ci machines run chrome in a container where its sandbox isn't available
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  "about:blank",
], { stdio: "ignore" });

async function waitForBrowser() {
  // a cold browser on a busy ci machine can take a while to start
  for (let i = 0; i < 600; i++) {
    try { return await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); } catch { await sleep(100); }
  }
  throw new Error("browser didn't start");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await waitForBrowser();
const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    pageErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  } else if (msg.method === "Page.javascriptDialogOpening") {
    cdp("Page.handleJavaScriptDialog", { accept: true });
  }
};
function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, what, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evaluate(`Boolean(${expression})`)) return; } catch { /* page still loading */ }
    await sleep(80);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
async function go(url) {
  await cdp("Page.navigate", { url });
  await waitFor("document.readyState === 'complete'", "page load");
  // the app shows its ~3 second startup screen first. the admin panel has none.
  await waitFor("!document.getElementById('splash') || document.getElementById('splash').classList.contains('done')", "startup screen", 30000);
  if (await evaluate("Boolean(document.getElementById('splash'))")) await sleep(450); // let it finish fading out
  // the first launch asks to accept the terms
  if (await evaluate("Boolean(document.querySelector('dialog.terms-sheet[open]'))")) {
    await evaluate("document.getElementById('terms-agree').click()");
    await evaluate("[...document.querySelectorAll('dialog.terms-sheet button')].find(b => b.textContent.includes('Agree')).click()");
    await waitFor("!document.querySelector('dialog.terms-sheet')", "terms accepted");
  }
}
async function setFile(selector, path) {
  const { result } = await cdp("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
  await cdp("DOM.setFileInputFiles", { files: Array.isArray(path) ? path : [path], objectId: result.objectId });
}
async function screenshot(name) {
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(screens, `${name}.png`), Buffer.from(data, "base64"));
}
async function setSize(width, height) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
}

// page helpers, injected as strings
const type = (sel, text) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
const choose = (sel, value) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const click = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('missing ' + ${JSON.stringify(sel)}); el.click(); return true; })()`;
const clickText = (sel, text) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(sel)} + ' with text ' + ${JSON.stringify(text)}); el.click(); return true; })()`;
const rows = `[...document.querySelectorAll('.mod-row:not(.skeleton-row)')]`;
const rowNames = `${rows}.map(r => r.querySelector('.row-link').textContent)`;

const results = [];
async function test(name, fn) {
  const errorsBefore = pageErrors.length;
  try {
    await fn();
    const newErrors = pageErrors.slice(errorsBefore);
    if (newErrors.length) throw new Error(`page errors: ${newErrors.join(" | ")}`);
    results.push([true, name]);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push([false, name, err.message]);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    await screenshot(`fail-${name.replace(/[^a-z0-9]+/gi, "-")}`).catch(() => {});
  }
}
function assert(ok, message) {
  if (!ok) throw new Error(message);
}

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
await setSize(1280, 800);
// start in light mode no matter what the computer is set to. dark mode gets its own test.
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

console.log(`testing against the demo server with ${browserPath}`);

// ---------- desktop app interface ----------

await test("startup screen shows what it loads and takes about 3 seconds", async () => {
  const started = Date.now();
  await cdp("Page.navigate", { url: `${BASE}/` });
  await waitFor(`document.getElementById("splash-detail")?.textContent.includes("(demo)")`, "a mod name on the startup screen", 9000);
  await screenshot("startup");
  await waitFor(`document.getElementById("splash")?.classList.contains("done") || !document.getElementById("splash")`, "startup finished", 8000);
  const took = Date.now() - started;
  assert(took >= 2800 && took < 6000, `startup took ${took}ms`);
  assert(await evaluate(`document.documentElement.dataset.theme === undefined`), "light mode should be the default");
});

await test("terms must be accepted before using the app, once", async () => {
  await waitFor(`document.querySelector("dialog.terms-sheet[open]")`, "terms screen");
  await sleep(400);
  await screenshot("terms");
  const agree = `[...document.querySelectorAll("dialog.terms-sheet button")].find(b => b.textContent.includes("Agree"))`;
  assert(await evaluate(`${agree}.disabled`), "agree should start disabled");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(200);
  assert(await evaluate(`Boolean(document.querySelector("dialog.terms-sheet[open]"))`), "escape must not skip the terms");
  await evaluate(click("#terms-agree"));
  await evaluate(`${agree}.click()`);
  await waitFor(`!document.querySelector("dialog.terms-sheet")`, "terms closed");
  await go(`${BASE}/`);
  assert(!(await evaluate(`Boolean(document.querySelector("dialog.terms-sheet"))`)), "terms asked twice");
});

await test("browse list loads with skeletons first", async () => {
  await go(`${BASE}/`);
  await waitFor(`${rows}.length >= 10`, "mod rows");
  assert(await evaluate(`document.querySelector('.view-count').textContent.includes('mods')`), "count text missing");
  assert(await evaluate(`document.querySelectorAll('#category-nav a').length === 5`), "sidebar categories missing");
  await screenshot("browse-light");
});

await test("search narrows the list and clear filters resets it", async () => {
  await evaluate(type("#search", "lantern"));
  await waitFor(`${rows}.length === 1`, "one search result");
  assert((await evaluate(rowNames))[0].includes("Lantern"), "wrong search result");
  await evaluate(clickText(".filters button", "Clear filters"));
  await waitFor(`${rows}.length >= 10 && document.querySelector('#search').value === ''`, "full list again");
});

await test("search with no results shows an empty state", async () => {
  await evaluate(type("#search", "zzzz-nothing"));
  await waitFor(`document.querySelector('.state-block h2')?.textContent === 'No mods match'`, "empty state");
  await evaluate(clickText(".state-block button", "Clear filters"));
  await waitFor(`${rows}.length >= 10`, "list back");
});

await test("category, compatibility and sort filters work", async () => {
  await evaluate(choose("#filter-category", "maps"));
  await waitFor(`${rows}.length > 0 && ${rows}.every(r => r.querySelector('.row-meta').textContent.includes('Maps'))`, "only maps");
  assert(await evaluate(`location.hash.includes('category=maps')`), "hash didn't keep the category");
  await evaluate(choose("#filter-category", ""));
  await evaluate(choose("#filter-compat", "broken"));
  await waitFor(`${rows}.length > 0 && ${rows}.every(r => r.querySelector('.badge').classList.contains('broken'))`, "only broken");
  await evaluate(choose("#filter-compat", ""));
  await evaluate(choose("#filter-sort", "name"));
  await waitFor(`${rows}.length >= 10`, "sorted list");
  const names = await evaluate(rowNames);
  assert(JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), "not sorted by name");
  await evaluate(choose("#filter-sort", "updated"));
  await waitFor(`${rows}.length >= 10`, "list");
});

await test("opening a mod and going back keeps search and scroll", async () => {
  await setSize(1280, 600);
  await evaluate(type("#search", "demo"));
  // the search waits 250ms before it runs, then the list reloads
  await sleep(500);
  await waitFor(`${rows}.length >= 10 && document.querySelector('.mod-list').getAttribute('aria-busy') === 'false'`, "results");
  await sleep(200);
  await evaluate(`document.getElementById('main').scrollTop = 300`);
  await sleep(100);
  await evaluate(`${rows}[6].querySelector('.row-link').click()`);
  await waitFor(`document.querySelector('.detail-title')`, "mod page");
  await evaluate(`history.back()`);
  await waitFor(`${rows}.length >= 10`, "list after back");
  await sleep(200);
  assert(await evaluate(`document.querySelector('#search').value === 'demo'`), "search text was lost");
  const top = await evaluate(`document.getElementById('main').scrollTop`);
  assert(Math.abs(top - 300) < 5, `scroll position was ${top}, expected 300`);
  await setSize(1280, 800);
// start in light mode no matter what the computer is set to. dark mode gets its own test.
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await evaluate(clickText(".filters button", "Clear filters"));
});

await test("favorites are saved and survive a reload", async () => {
  await go(`${BASE}/#/browse`);
  await waitFor(`${rows}.length >= 10`, "rows");
  const first = await evaluate(`${rows}[0].dataset.slug`);
  await evaluate(`${rows}[0].querySelector('.fav-toggle').click()`);
  assert(await evaluate(`${rows}[0].querySelector('.fav-toggle').getAttribute('aria-pressed') === 'true'`), "star not pressed");
  await go(`${BASE}/#/favorites`);
  await waitFor(`${rows}.length === 1`, "one favorite");
  await go(`${BASE}/#/favorites`);
  await cdp("Page.reload");
  await waitFor(`${rows}.length === 1 && ${rows}[0].dataset.slug === ${JSON.stringify(first)}`, "favorite after reload");
});

await test("hosted download shows progress and finishes", async () => {
  await go(`${BASE}/#/mod/demo-lantern-trail`);
  await waitFor(`document.querySelector('.detail-title')`, "mod page");
  for (const heading of ["About this mod", "How to install", "Changelog"]) {
    assert(await evaluate(`[...document.querySelectorAll('.detail-section h2')].some(h => h.textContent === ${JSON.stringify(heading)})`), `missing section ${heading}`);
  }
  assert(await evaluate(`document.querySelector('.checksum code').textContent.length === 64`), "checksum missing");
  assert(await evaluate(`!document.querySelector('.prose script, .prose img, .prose iframe')`), "unsafe markup in description");
  assert(await evaluate(`[...document.querySelectorAll(".hero-secondary button")].some(b => b.textContent.includes("View source code"))`), "github source button missing");
  await screenshot("detail-light");
  await evaluate(clickText(".download-area button", "Download"));
  await waitFor(`document.querySelector('.progress')`, "progress bar", 3000);
  await screenshot("detail-downloading");
  await waitFor(`document.querySelector('.download-status .banner.ok')`, "download finished", 10000);
});

await test("recently viewed lists opened mods", async () => {
  await go(`${BASE}/#/recent`);
  await waitFor(`${rows}.length >= 1`, "recent rows");
  assert((await evaluate(`${rows}[0].dataset.slug`)) === "demo-lantern-trail", "most recent mod should be first");
});

await test("failed download shows an error with retry", async () => {
  await go(`${BASE}/#/mod/demo-practice-timer`);
  await waitFor(`document.querySelector('.detail-title')`, "mod page");
  await evaluate(clickText(".download-area button", "Download"));
  await waitFor(`document.querySelector('.download-status .banner.danger')`, "error banner");
  assert(await evaluate(`document.querySelector('.download-status').textContent.includes('fails on purpose')`), "error message not shown");
  assert(await evaluate(`[...document.querySelectorAll('.download-status button')].some(b => b.textContent.includes('Try again'))`), "no retry button");
});

await test("turned-off downloads and author links are labeled", async () => {
  await go(`${BASE}/#/mod/demo-old-menu-kit`);
  await waitFor(`document.querySelector('.detail-title')`, "mod page");
  assert(await evaluate(`document.querySelector('.download-area button').disabled && document.querySelector('.download-area').textContent.includes('turned off')`), "disabled download not explained");
  assert(await evaluate(`document.querySelector('.banner.danger, .banner.warn')`), "compatibility warning missing");
  await go(`${BASE}/#/mod/demo-canopy-camera`);
  await waitFor(`document.querySelector('.detail-title')`, "mod page");
  assert(await evaluate(`document.querySelector('.download-area button').textContent.includes('Get it from example.com')`), "external button label wrong");
});

await test("missing mods show a not available page", async () => {
  await go(`${BASE}/#/mod/does-not-exist`);
  await waitFor(`document.querySelector('.state-block h2')?.textContent.includes("isn't available")`, "not found state");
});

await test("report form validates and sends", async () => {
  await go(`${BASE}/#/mod/demo-lantern-trail`);
  await waitFor(`document.querySelector('.detail-title')`, "mod page");
  await evaluate(clickText(".hero-secondary button", "Report"));
  await waitFor(`document.querySelector('dialog[open] form')`, "report dialog");
  await evaluate(click("dialog[open] button[type=submit]"));
  await waitFor(`!document.querySelector('#report-reason-error').hidden`, "reason error");
  await evaluate(click("dialog[open] input[value=other]"));
  await evaluate(click("dialog[open] button[type=submit]"));
  await waitFor(`!document.querySelector('#report-details-error').hidden`, "details error");
  await evaluate(type("#report-details", "e2e test report: the link is broken"));
  await screenshot("report-dialog");
  await evaluate(click("dialog[open] button[type=submit]"));
  await waitFor(`document.querySelector('dialog[open] .sheet-title')?.textContent === 'Report sent'`, "report sent");
  await evaluate(clickText("dialog[open] button", "Done"));
});

await test("dark mode setting applies and persists", async () => {
  await go(`${BASE}/#/settings`);
  await waitFor(`document.querySelector('input[name=theme][value=dark]')`, "settings");
  await evaluate(click("input[name=theme][value=dark]"));
  assert(await evaluate(`document.documentElement.dataset.theme === 'dark'`), "theme not applied");
  await screenshot("settings-dark");
  await go(`${BASE}/#/browse`);
  await waitFor(`${rows}.length >= 10 && document.documentElement.dataset.theme === 'dark'`, "dark browse");
  await sleep(300);
  await screenshot("browse-dark");
  await go(`${BASE}/#/mod/demo-lantern-trail`);
  await waitFor(`document.querySelector('.detail-title')`, "mod page");
  await sleep(300);
  await screenshot("detail-dark");
  await go(`${BASE}/#/settings`);
  await waitFor(`document.querySelector('input[name=theme][value=system]')`, "settings");
  await evaluate(click("input[name=theme][value=system]"));
});

await test("about and legal pages open", async () => {
  await go(`${BASE}/#/about`);
  await waitFor(`document.querySelector('.made-by')?.textContent === 'made by Drifted'`, "about page");
  await evaluate(clickText(".link-row", "Privacy Notice"));
  await waitFor(`document.querySelector('.legal-doc h3')?.textContent === 'Privacy Notice'`, "privacy page");
});

await test("narrow window collapses the sidebar", async () => {
  await setSize(760, 800);
  await go(`${BASE}/#/browse`);
  await waitFor(`${rows}.length >= 10`, "rows");
  assert(await evaluate(`getComputedStyle(document.querySelector('.sidebar-toggle')).display !== 'none'`), "toggle hidden");
  await screenshot("browse-narrow");
  await evaluate(click("#sidebar-toggle"));
  await waitFor(`document.getElementById('sidebar').classList.contains('open')`, "sidebar open");
  await sleep(300);
  await screenshot("browse-narrow-sidebar");
  assert(await evaluate(`document.documentElement.scrollWidth <= 760`), "page scrolls sideways");
  await setSize(1280, 800);
// start in light mode no matter what the computer is set to. dark mode gets its own test.
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
});

await test("keyboard: ctrl+f focuses search and arrows move through rows", async () => {
  await go(`${BASE}/#/browse`);
  await waitFor(`${rows}.length >= 10`, "rows");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", modifiers: 2, windowsVirtualKeyCode: 70 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", modifiers: 2, windowsVirtualKeyCode: 70 });
  await waitFor(`document.activeElement?.id === 'search'`, "search focused");
  await evaluate(`${rows}[0].querySelector('.row-link').focus()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  assert(await evaluate(`document.activeElement === ${rows}[1].querySelector('.row-link')`), "arrow down didn't move focus");
});

await test("community upload needs a file, name, description and rights confirmation", async () => {
  const modFile = join(profile, "TinyHats.dll");
  writeFileSync(modFile, Buffer.from("MZ demo tiny hats BepInEx"));
  await go(`${BASE}/#/upload`);
  await waitFor(`document.querySelector("#up-name")`, "upload form");
  await evaluate(click(".form-card button[type=submit]"));
  await waitFor(`!document.querySelector("#up-file-error").hidden && !document.querySelector("#up-description-error").hidden && !document.querySelector("#up-confirm-error").hidden`, "required field errors");
  await setFile("#up-file", modFile);
  await waitFor(`document.querySelector(".file-chosen").textContent.includes("TinyHats.dll")`, "chosen file shown");
  await evaluate(type("#up-name", "E2E Tiny Hats"));
  await evaluate(type("#up-description", "too short"));
  await evaluate(click("#up-confirm"));
  await evaluate(click(".form-card button[type=submit]"));
  await waitFor(`!document.querySelector("#up-description-error").hidden`, "description too short");
  await evaluate(type("#up-description", "adds tiny hats to every player in private lobbies. demo upload."));
  await evaluate(click("#up-anonymous"));
  assert(await evaluate(`document.querySelector("#up-author").disabled`), "author field should lock when anonymous");
  await screenshot("upload");
  await evaluate(click(".form-card button[type=submit]"));
  await waitFor(`document.querySelector(".state-block h2")?.textContent === "Your mod is live"`, "upload done", 8000);
  await evaluate(clickText(".state-block a", "View your mod"));
  await waitFor(`document.querySelector(".detail-title")?.textContent === "E2E Tiny Hats"`, "uploaded mod page");
  assert(await evaluate(`document.querySelector(".byline").textContent.includes("Anonymous")`), "author should be Anonymous");
  assert(await evaluate(`document.querySelector(".detail-warnings").textContent.includes("Community upload")`), "community note missing");
  await go(`${BASE}/#/browse`);
  await waitFor(`[...document.querySelectorAll(".mod-row")].some(r => r.textContent.includes("E2E Tiny Hats") && r.textContent.includes("Community"))`, "community badge in the list");
});

await test("mod checker uploads a file and animates the suspicion meter", async () => {
  const sample = join(profile, "free-cosmetics.dll");
  writeFileSync(sample, Buffer.from("MZ demo https://discord.com/api/webhooks/1/x CreateRemoteThread \\Local Storage\\leveldb", "latin1"));
  await go(`${BASE}/#/check`);
  await waitFor(`document.querySelector(".usage")?.textContent.includes("20 of 20")`, "usage text");
  await setFile("#checker-file", sample);
  await waitFor(`document.querySelector(".drop-card.scanning")`, "scanning state", 3000);
  await waitFor(`document.querySelector(".result-card")`, "result", 8000);
  await sleep(300);
  const midway = await evaluate(`Number(document.querySelector(".meter-number").textContent)`);
  await sleep(1500);
  const final = await evaluate(`Number(document.querySelector(".meter-number").textContent)`);
  assert(final === 100 || final >= 90, `final score ${final}`);
  assert(midway < final, "the meter should count up");
  assert(await evaluate(`document.querySelector(".verdict").textContent === "Likely malicious"`), "verdict wrong");
  assert(await evaluate(`document.querySelector(".usage").textContent.includes("19 of 20")`), "usage didn't go down");
  assert(await evaluate(`document.querySelector(".what-it-does")?.textContent.includes("webhook")`), "what-it-does section missing");
  assert(await evaluate(`document.querySelectorAll(".capabilities .cap.dangerous").length === 2`), "capabilities missing");
  assert(await evaluate(`document.querySelector(".confidence")?.textContent === "high confidence"`), "confidence missing");
  await screenshot("checker-result");
});

await test("community name can be changed in settings, but not to a staff-like name", async () => {
  await go(`${BASE}/#/settings`);
  await waitFor(`document.querySelector("#community-name")?.value.startsWith("DemoClimber")`, "random name loaded");
  await evaluate(type("#community-name", "Branch Admin"));
  await evaluate(clickText(".community-buttons button", "Save name"));
  await waitFor(`!document.querySelector("#community-name-error").hidden`, "staff name refused");
  await evaluate(type("#community-name", "Cool Climber"));
  await evaluate(clickText(".community-buttons button", "Save name"));
  await waitFor(`[...document.querySelectorAll(".toast")].some(t => t.textContent.includes("Name saved"))`, "name saved");
});

await test("community forum: post a thread, reply and report", async () => {
  await go(`${BASE}/#/forum`);
  await waitFor(`document.querySelector(".identity-badge")?.textContent.includes("Cool Climber")`, "posting-as badge");
  await waitFor(`document.querySelector(".state-block h2")?.textContent === "No posts yet"`, "empty forum");
  await evaluate(clickText(".forum-head button", "New post"));
  await waitFor(`document.querySelector("#forum-title-input")`, "composer");
  await evaluate(choose("#forum-board", "help"));
  await evaluate(type("#forum-title-input", "hi"));
  await evaluate(type("#forum-body", "short"));
  await evaluate(click(".composer button[type=submit]"));
  await waitFor(`!document.querySelector('.composer [data-error="title"]').hidden`, "validation");
  await evaluate(type("#forum-title-input", "how do i install bepinex?"));
  await evaluate(type("#forum-body", "the mods folder never shows up after i install it."));
  await screenshot("forum-compose");
  await evaluate(click(".composer button[type=submit]"));
  await waitFor(`document.querySelector(".thread-header h1")?.textContent === "how do i install bepinex?"`, "thread page");
  await evaluate(type("#forum-reply", "run the game once after installing it."));
  await evaluate(click(".reply-form button[type=submit]"));
  await waitFor(`document.querySelectorAll(".replies .post").length === 1`, "reply shown");
  assert(await evaluate(`document.querySelector(".replies .post").textContent.includes("Cool Climber")`), "reply author missing");
  await evaluate(clickText(".replies .post button", "Report"));
  await waitFor(`document.querySelector("#forum-report-reason")`, "report sheet");
  await evaluate(type("#forum-report-reason", "demo report"));
  await evaluate(clickText("dialog[open] button", "Send report"));
  await waitFor(`!document.querySelector("dialog[open]")`, "report sent");
  await screenshot("forum-thread");
  await evaluate(clickText(".back-link", "Community"));
  await waitFor(`[...document.querySelectorAll(".thread-row")].some(r => r.textContent.includes("how do i install bepinex?") && r.textContent.includes("1"))`, "thread in the list");
  await screenshot("forum-list");
});

await test("main chat: send a message and see other people's messages arrive live", async () => {
  await go(`${BASE}/#/forum/chat`);
  await waitFor(`document.querySelector(".community-tabs a[aria-current=page]")?.textContent === "Chat" && document.querySelector("#chat-input")`, "chat page");
  await evaluate(type("#chat-input", "hello everyone"));
  await evaluate(click(".chat-form button[type=submit]"));
  await waitFor(`[...document.querySelectorAll(".chat-msg")].some(m => m.textContent.includes("hello everyone") && m.textContent.includes("Cool Climber"))`, "own message");
  // someone else talks from another computer
  const otherKey = "e".repeat(64);
  await evaluate(`fetch("/api/forum/me", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "${otherKey}" }) }).then(() => fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "${otherKey}", body: "hi! anyone got a hat mod?" }) }))`);
  await waitFor(`[...document.querySelectorAll(".chat-msg")].some(m => m.textContent.includes("anyone got a hat mod"))`, "live message from someone else", 8000);
  await screenshot("chat");
});

await test("clicking the about icon 7 times opens the admin panel", async () => {
  await go(`${BASE}/#/about`);
  await waitFor(`document.querySelector(".about-icon")`, "about page");
  await evaluate(`for (let i = 0; i < 7; i++) document.querySelector(".about-icon").click()`);
  await waitFor(`[...document.querySelectorAll(".toast")].some(t => t.textContent.includes("admin panel"))`, "admin toast");
});
await test("tree of life draws every mod as a node, zooms, finds and opens mods", async () => {
  await setSize(1280, 820);
  await go(`${BASE}/#/tree`);
  await waitFor(`/^\\d+ mods/.test(document.querySelector(".tree-stats")?.textContent || "")`, "tree stats");
  const count = await evaluate(`parseInt(document.querySelector(".tree-stats").textContent)`);
  const published = await evaluate(`fetch("/api/mods?per_page=100").then(r => r.json()).then(d => d.total)`);
  assert(count === published, `tree has ${count} mods, the catalog has ${published}`);
  assert(await evaluate(`document.querySelectorAll(".tree-chip").length >= 3`), "category legend missing");
  await sleep(3200);
  await screenshot("tree-small");
  // a drawn canvas has solid pixels somewhere (the trunk)
  assert(await evaluate(`(() => { const c = document.querySelector(".tree-canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) return true; return false; })()`), "canvas is empty");
  await evaluate(type(".tree-search", "lantern"));
  await waitFor(`document.querySelector(".tree-results:not([hidden]) button")`, "search result");
  await evaluate(click(".tree-results button"));
  await sleep(700);
  await screenshot("tree-zoomed");
  // the found mod is now in the middle: click it
  const box = await evaluate(`(() => { const r = document.querySelector(".tree-canvas").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await waitFor(`location.hash.startsWith("#/mod/") && document.querySelector(".detail-title")`, "mod page after clicking a node");
  await go(`${BASE}/#/tree`);
  await waitFor(`document.querySelector(".tree-chip")`, "back on the tree");
  await evaluate(clickText(".tree-tools button", "View as list"));
  await waitFor(`document.querySelectorAll(".tree-list a").length === ${count}`, "list view with every mod");
  await evaluate(clickText(".tree-tools button", "View as tree"));
  // a pretend big catalog, to see how the tree fills out
  await evaluate(`(() => { const cats = [["hats","Hats"],["movement","Movement"],["ui","Interface"],["maps","Maps"],["sounds","Sounds"],["cosmetics","Cosmetics"],["tools","Tools"],["fun","Fun"]]; const mods = []; for (let i = 0; i < 900; i++) { const c = cats[(i * 7 + (i % 5)) % cats.length]; const w = i % 9 === 0 ? null : c; mods.push({ slug: "m" + i, name: "Mod Number " + i, category_slug: w && w[0], category_name: w && w[1], downloads: i, community: i % 3 === 0 }); } window.__branchTree.setMods(mods); return true; })()`);
  await sleep(3200);
  await screenshot("tree-big");
  await evaluate(`document.querySelector(".tree-canvas").dispatchEvent(new WheelEvent("wheel", { deltaY: -1200, clientX: 700, clientY: 420, bubbles: true, cancelable: true }))`);
  await sleep(300);
  await screenshot("tree-big-zoom");
});

// ---------- admin panel ----------

await test("admin login rejects a wrong password", async () => {
  await go(`${BASE}/admin`);
  await waitFor(`document.querySelector('#login-username')`, "login form");
  await evaluate(type("#login-username", "demo-admin"));
  await evaluate(type("#login-password", "wrong"));
  await evaluate(click("form button[type=submit]"));
  await waitFor(`!document.querySelector('.form-error').classList.contains('hidden')`, "login error");
  await screenshot("admin-login");
});

await test("admin must change the starting password", async () => {
  await evaluate(type("#login-password", "demo-password-1234"));
  await evaluate(click("form button[type=submit]"));
  await waitFor(`document.querySelector('#pw-new')`, "password change screen");
  await evaluate(type("#pw-current", "demo-password-1234"));
  await evaluate(type("#pw-new", "short"));
  await evaluate(type("#pw-again", "short"));
  await evaluate(click("form button[type=submit]"));
  await waitFor(`[...document.querySelectorAll('.error')].some(e => !e.classList.contains('hidden') && e.textContent.includes('12'))`, "too short error");
  await evaluate(type("#pw-new", "a much better demo passphrase"));
  await evaluate(type("#pw-again", "a much better demo passphrase"));
  await evaluate(click("form button[type=submit]"));
  await waitFor(`document.querySelector('.page-head h1')?.textContent === 'All mods'`, "mods list");
  await screenshot("admin-mods");
});

await test("admin creates, publishes, unpublishes and deletes a mod", async () => {
  await evaluate(clickText("a.btn", "New mod"));
  await waitFor(`document.querySelector('#name')`, "editor");
  await evaluate(clickText(".editor-bar button", "Save draft"));
  await waitFor(`!document.querySelector('#name-error').classList.contains('hidden')`, "name required error");
  await evaluate(type("#name", "E2E Test Mod"));
  await evaluate(type("#summary", "kept after a failed save"));
  await evaluate(clickText(".editor-bar button", "Save draft"));
  await waitFor(`/#\\/mods\\/[0-9a-f-]{36}/.test(location.hash) && document.querySelector('.editor-bar .pill')?.textContent === 'draft'`, "saved draft");
  assert(await evaluate(`document.querySelector('#summary').value === 'kept after a failed save'`), "form lost what was typed");

  await evaluate(clickText(".editor-bar button", "Publish"));
  await waitFor(`!document.querySelector('#author_name-error').classList.contains('hidden')`, "publish needs author");
  await evaluate(type("#author_name", "E2E Author"));
  await evaluate(choose("#category_id", await evaluate(`document.querySelector('#category_id option:nth-child(2)').value`)));
  await evaluate(type("#license_name", "MIT"));
  await evaluate(clickText(".editor-bar button", "Save"));
  await waitFor(`document.querySelector('.unsaved').classList.contains('hidden')`, "saved");

  await evaluate(clickText("button", "Add release"));
  await waitFor(`document.querySelector('#rel-version-new')`, "release form");
  await evaluate(type("#rel-version-new", "1.0.0"));
  await evaluate(type("#rel-url-new", "https://example.com/e2e-release"));
  await evaluate(clickText(".release-form button[type=submit]", "Add release"));
  await waitFor(`document.querySelector('.release .pill.published')`, "working release");

  await evaluate(clickText(".editor-bar button", "Publish"));
  await waitFor(`document.querySelector('.editor-bar .pill')?.textContent === 'published'`, "published");
  await screenshot("admin-editor");
  const listed = await evaluate(`fetch('/api/mods?q=E2E%20Test%20Mod').then(r => r.json()).then(d => d.items.length)`);
  assert(listed === 1, "published mod not in the public list");

  await evaluate(clickText(".editor-bar button", "Preview"));
  await waitFor(`document.querySelector('dialog.preview[open]')`, "preview");
  await evaluate(clickText("dialog.preview button", "Close preview"));

  await evaluate(clickText(".editor-bar button", "Unpublish"));
  await waitFor(`document.querySelector('.editor-bar .pill')?.textContent === 'unpublished'`, "unpublished");
  const hidden = await evaluate(`fetch('/api/mods?q=E2E%20Test%20Mod').then(r => r.json()).then(d => d.items.length)`);
  assert(hidden === 0, "unpublished mod still public");

  await evaluate(clickText(".editor-bar button", "Delete"));
  await waitFor(`document.querySelector('dialog[open]')`, "confirm dialog");
  await evaluate(clickText("dialog[open] button", "Delete forever"));
  await waitFor(`document.querySelector('.page-head h1')?.textContent === 'All mods'`, "back on list");
  assert(!(await evaluate(`document.body.textContent.includes('E2E Test Mod')`)), "deleted mod still listed");
});

await test("admin sees every mod, filters community uploads and removes one", async () => {
  await go(`${BASE}/admin#/mods`);
  await waitFor(`document.querySelector(".page-head h1")?.textContent === "All mods"`, "all mods list");
  await evaluate(choose(".toolbar-row select:nth-of-type(2)", "community"));
  await waitFor(`document.querySelectorAll("tbody tr").length === 1 && document.querySelector("tbody").textContent.includes("E2E Tiny Hats")`, "only the community upload");
  await screenshot("admin-all-mods");
  await evaluate(clickText("tbody .row-actions button", "Remove"));
  await waitFor(`document.querySelector("dialog[open]")`, "confirm");
  await evaluate(clickText("dialog[open] button", "Remove forever"));
  await waitFor(`!document.querySelector("tbody") || !document.querySelector("tbody").textContent.includes("E2E Tiny Hats")`, "removed");
  assert((await evaluate(`fetch("/api/mods?q=Tiny%20Hats").then(r => r.json()).then(d => d.total)`)) === 0, "removed mod is still public");
});

await test("admin moderates a reported forum post", async () => {
  await go(`${BASE}/admin#/forum`);
  await waitFor(`document.querySelector(".report")?.textContent.includes("demo report")`, "reported post");
  await screenshot("admin-forum");
  await evaluate(clickText(".report-actions button", "Remove"));
  await waitFor(`!document.querySelector(".report")`, "report cleared");
  const thread = await evaluate(`fetch("/api/forum/threads").then(r => r.json()).then(d => d.items[0].id)`);
  const body = await evaluate(`fetch("/api/forum/threads/${thread}").then(r => r.json()).then(d => d.replies[0].body)`);
  assert(body === "[removed by a moderator]", `reply still shows: ${body}`);
});

await test("admin bulk-imports mods into a private drafts list", async () => {
  const a = join(profile, "GorillaHats_v1.4.dll");
  const b = join(profile, "SpeedReadout.dll");
  writeFileSync(a, Buffer.from("MZ demo hats"));
  writeFileSync(b, Buffer.from("MZ demo speed"));
  await go(`${BASE}/admin#/import`);
  await waitFor(`document.querySelector("#import-files")`, "import page");
  await setFile("#import-files", [a, b]);
  await waitFor(`[...document.querySelectorAll(".import-queue li")].filter(li => li.textContent.includes("added 1 draft")).length === 2`, "both imported", 8000);
  await waitFor(`document.querySelector(".import-heading")?.textContent.includes("(2)")`, "imported drafts list");
  assert(await evaluate(`document.body.textContent.includes("Gorilla Hats")`), "name not taken from the file name");
  await screenshot("admin-import");
  assert((await evaluate(`fetch("/api/mods?q=Gorilla%20Hats").then(r => r.json()).then(d => d.total)`)) === 0, "imported drafts must not be public");
  await evaluate(clickText("a.btn", "Fill in"));
  await waitFor(`document.querySelector(".notice-box")?.textContent.includes("imported from")`, "import note in editor");
});

await test("rewards: reach 10 unique uploads, apply, get accepted, earn and get paid", async () => {
  await go(`${BASE}/#/rewards`);
  await waitFor(`document.querySelector(".rw-hero h1")?.textContent.includes("Earn Robux")`, "rewards page");
  assert(await evaluate(`document.querySelector(".rw-pill").textContent.includes("Limited-time offer")`), "limited-time label missing");
  await waitFor(`document.querySelector(".rw-big")`, "progress");
  await sleep(1200);
  await screenshot("rewards-progress");
  // upload until this person has 10 unique mods (each file is different)
  await evaluate(`(async () => {
    const key = localStorage.getItem("branch.forumKey");
    for (let i = 0; i < 12; i++) {
      const me = await fetch("/api/rewards/me", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }).then(r => r.json());
      if (me.uploads >= 10) break;
      const form = new FormData();
      form.append("name", "Reward Test Mod " + i);
      form.append("description", "a unique demo mod made only for the rewards test number " + i);
      form.append("confirm", "true");
      form.append("key", key);
      form.append("file", new Blob(["MZ unique reward test " + i + " " + Math.random()]), "reward" + i + ".dll");
      await fetch("/api/submissions", { method: "POST", body: form });
    }
  })()`);
  // open another page first: going to the same address again wouldn't reload anything
  await go(`${BASE}/#/browse`);
  await go(`${BASE}/#/rewards`);
  await waitFor(`document.querySelector(".rw-big span")?.textContent === "10" && document.querySelector("#rw-username")`, "apply form after 10 uploads");
  await evaluate(type("#rw-username", "x"));
  await evaluate(type("#rw-item", "https://evil.example/item"));
  await evaluate(click(".rw-apply button[type=submit]"));
  await waitFor(`!document.querySelector('[data-error="roblox_username"]').hidden && !document.querySelector('[data-error="payout_item_url"]').hidden && !document.querySelector('[data-error="confirm"]').hidden`, "validation errors");
  await evaluate(type("#rw-username", "Cool_Climber"));
  await evaluate(type("#rw-item", "https://www.roblox.com/game-pass/123456/Support"));
  await evaluate(click("#rw-confirm"));
  await screenshot("rewards-apply");
  await evaluate(click(".rw-apply button[type=submit]"));
  await waitFor(`document.querySelector(".rw-status.pending h2")?.textContent.includes("being reviewed")`, "pending review");

  await go(`${BASE}/admin#/rewards`);
  await waitFor(`document.querySelector(".report h2")?.textContent === "Cool_Climber"`, "application in admin");
  await screenshot("admin-rewards-application");
  await evaluate(clickText(".report-actions button", "Accept into rewards"));
  await waitFor(`document.querySelector("tbody")?.textContent.includes("Cool_Climber")`, "member listed");

  const modFile = join(profile, "BrandNewHat.dll");
  writeFileSync(modFile, Buffer.from("MZ brand new reward hat " + Date.now()));
  await go(`${BASE}/#/upload`);
  await waitFor(`document.querySelector("#up-name")`, "upload form");
  await setFile("#up-file", modFile);
  await evaluate(type("#up-name", "Brand New Hat"));
  await evaluate(type("#up-description", "a brand new hat mod uploaded after joining the rewards program."));
  await evaluate(click("#up-confirm"));
  await evaluate(click(".form-card button[type=submit]"));
  await waitFor(`document.querySelector(".reward-note.earned")?.textContent.includes("+10 R$")`, "+10 R$ after upload", 8000);

  await go(`${BASE}/#/rewards`);
  await waitFor(`document.querySelector(".rw-member h2")?.textContent.includes("Cool_Climber")`, "member dashboard");
  assert(await evaluate(`document.querySelector(".rw-events").textContent.includes("Brand New Hat")`), "reward not listed");
  await sleep(1300);
  await screenshot("rewards-dashboard");

  await go(`${BASE}/admin#/rewards`);
  await waitFor(`document.querySelector("tbody")?.textContent.includes("10 R$ owed")`, "owed in admin");
  await screenshot("admin-rewards");
  await evaluate(clickText(".row-actions button", "Mark paid"));
  await waitFor(`document.querySelector("dialog[open]")`, "confirm");
  await evaluate(clickText("dialog[open] button", "Mark as paid"));
  await waitFor(`!document.querySelector("tbody")?.textContent.includes("R$ owed")`, "paid");
});

await test("admin sees and resolves the report", async () => {
  await go(`${BASE}/admin#/reports`);
  await waitFor(`document.querySelector('.report')`, "report card");
  assert(await evaluate(`document.querySelector('.report-body').textContent.includes('e2e test report')`), "report text missing");
  await screenshot("admin-reports");
  await evaluate(clickText(".report-actions button", "Mark resolved"));
  await waitFor(`!document.querySelector('.report') || document.querySelector('.card p')?.textContent.includes('no open reports')`, "resolved");
});

// ---------- done ----------

ws.close();
browser.kill();
server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold files */ }

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. screenshots: ${screens}`);
process.exit(failed.length ? 1 : 0);
