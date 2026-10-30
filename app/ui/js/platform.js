const tauri = window.__TAURI__;
export const isDesktop = Boolean(tauri && tauri.core);

let apiBase = "";

export async function initPlatform() {
  if (!isDesktop) return;
  apiBase = await tauri.core.invoke("api_base");
}

export class ApiError extends Error {
  constructor(message, { status = null, kind = "http", fields = null } = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.fields = fields;
  }
}

function toApiError(err, fallback) {
  if (err instanceof ApiError) return err;
  if (err && typeof err === "object" && "message" in err) {
    return new ApiError(err.message || fallback, { status: err.status ?? null, kind: err.kind || "http", fields: err.fields || null });
  }
  return new ApiError(typeof err === "string" ? err : fallback, { kind: "network" });
}

export function assetUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//.test(path) || path.startsWith("data:")) return path;
  return apiBase + path;
}

export async function api(path, { method = "GET", body } = {}) {
  if (isDesktop) {
    try {
      return await tauri.core.invoke("api_request", { method, path, body: body ?? null });
    } catch (err) {
      throw toApiError(err, "couldn't reach the Branch server");
    }
  }

  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("couldn't reach the Branch server. check your internet connection.", { kind: "network" });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(data?.error || `the server answered with an error (${res.status})`, {
      status: res.status,
      fields: data?.fields || null,
    });
  }
  return data;
}

const browserDownloads = new Map();

export async function downloadRelease({ id, releaseId, fileName, sha256 }, onProgress) {
  if (isDesktop) {
    const unlisten = await tauri.event.listen("download-progress", (event) => {
      if (event.payload.id === id) onProgress(event.payload.received, event.payload.total);
    });
    try {
      return await tauri.core.invoke("download_release", {
        args: { id, releaseId, fileName, sha256: sha256 || null },
      });
    } catch (err) {
      throw toApiError(err, "the download failed");
    } finally {
      unlisten();
    }
  }

  const controller = new AbortController();
  browserDownloads.set(id, controller);
  try {
    const res = await fetch(`/api/releases/${encodeURIComponent(releaseId)}/download`, { signal: controller.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new ApiError(data?.error || `the download failed (${res.status})`, { status: res.status });
    }
    const total = Number(res.headers.get("content-length")) || null;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, total);
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(chunks));
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    return { status: "saved", path: null };
  } catch (err) {
    if (err.name === "AbortError") return { status: "cancelled" };
    if (err instanceof ApiError) throw err;
    throw new ApiError("the download stopped. check your connection and try again.", { kind: "network" });
  } finally {
    browserDownloads.delete(id);
  }
}

export async function cancelDownload(id) {
  if (isDesktop) await tauri.core.invoke("cancel_download", { id });
  else browserDownloads.get(id)?.abort();
}

export const canRevealFiles = isDesktop;

export async function revealFile(path) {
  if (isDesktop && path) await tauri.core.invoke("reveal_download", { path });
}

export async function openExternal(url) {
  if (isDesktop) await tauri.core.invoke("open_external", { url });
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function outboundUrl(releaseId) {
  return `${apiBase || location.origin}/api/releases/${encodeURIComponent(releaseId)}/out`;
}

export async function setNativeTheme(theme) {
  if (!isDesktop) return;
  try {
    await tauri.window.getCurrentWindow().setTheme(theme === "system" ? null : theme);
  } catch {
  }
}

export async function appVersion() {
  if (isDesktop) {
    try { return await tauri.app.getVersion(); } catch {}
  }
  return "preview";
}

export async function windowMaterial() {
  if (!isDesktop) return "none";
  try { return await tauri.core.invoke("window_material"); } catch { return "none"; }
}

export async function uploadForm(path, form) {
  if (isDesktop) {
    const packed = new Response(form);
    const contentType = packed.headers.get("content-type");
    const body = new Uint8Array(await packed.arrayBuffer());
    try {
      return await tauri.core.invoke("api_upload", body, { headers: { "x-branch-path": path, "x-branch-content-type": contentType } });
    } catch (err) {
      throw toApiError(err, "the upload failed");
    }
  }
  let res;
  try {
    res = await fetch(path, { method: "POST", body: form });
  } catch {
    throw new ApiError("couldn't reach the Branch server. check your internet connection.", { kind: "network" });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error || `the upload failed (${res.status})`, { status: res.status, fields: data?.fields || null });
  return data;
}

export const appWindow = isDesktop ? tauri.window.getCurrentWindow() : null;
export const githubFetch = isDesktop
  ? async (path) => {
      try {
        return await tauri.core.invoke("github_api", { path });
      } catch (err) {
        throw new Error(err?.message || "couldn't reach github.");
      }
    }
  : undefined;