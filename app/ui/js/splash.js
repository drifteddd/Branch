const TARGET_MS = 3000;
const GIVE_UP_MS = 12000;

export async function runSplash(work) {
  const splash = document.getElementById("splash");
  const fill = document.getElementById("splash-fill");
  const detail = document.getElementById("splash-detail");
  if (!splash) return work(() => {});

  const messages = ["Starting Branch"];
  const say = (text) => messages.push(text);
  let finished = false;
  const job = Promise.resolve()
    .then(() => work(say))
    .catch(() => {})
    .finally(() => { finished = true; });

  const start = performance.now();
  let shown = -1;

  await new Promise((resolve) => {
    const frame = (now) => {
      const elapsed = now - start;
      const timeShare = Math.min(1, elapsed / TARGET_MS);
      const progress = finished ? timeShare : Math.min(timeShare, 0.92);
      fill.style.transform = `scaleX(${progress})`;

      const index = Math.min(messages.length - 1, Math.floor(progress * messages.length));
      if (index !== shown) {
        shown = index;
        detail.textContent = messages[index];
      }

      const done = (finished && elapsed >= TARGET_MS) || elapsed >= GIVE_UP_MS;
      if (done) {
        fill.style.transform = "scaleX(1)";
        detail.textContent = "Ready";
        resolve();
      } else {
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
  });

  void job;
  await new Promise((r) => setTimeout(r, 180));
  splash.classList.add("done");
  splash.setAttribute("aria-hidden", "true");
  await new Promise((r) => setTimeout(r, 400));
  splash.remove();
}
