// Shared "save a generated file to the user's device" helper, used by both
// the PDF Download button and the Share button.
//
// Why this exists: a plain `<a download>` click is blocked in some sandboxed
// viewers (e.g. when this app is running inside a hosted preview frame), so a
// single fallback chain is used everywhere a file is offered to the user:
//   1. The host's own save capability, if one is exposed at
//      `window.claude.use("downloads")` - this is required in a sandboxed
//      preview frame, where a raw anchor click is silently blocked.
//   2. A normal browser download via a temporary <a download> link - works in
//      any regular browser tab (including the standalone Share page).
//   3. Opening the file in a new tab as a last resort, so the user can use
//      their browser's own Save/Share action.
//
// Returns { ok, declined, via, attemptLog } so callers can show an accurate
// status message instead of assuming success.
export async function saveGeneratedFile({ filename, data }) {
  const attemptLog = [];

  if (typeof window !== "undefined" && window.claude && typeof window.claude.use === "function") {
    try {
      const downloadsApi = await window.claude.use("downloads");
      if (downloadsApi) {
        try {
          await downloadsApi.save({ filename, data });
          return { ok: true, via: "claude-downloads", attemptLog: [...attemptLog, "Save dialog: succeeded"] };
        } catch (saveErr) {
          if (saveErr && saveErr.code === "declined") {
            return { ok: false, declined: true, attemptLog: [...attemptLog, "Save dialog: you declined the save prompt"] };
          }
          attemptLog.push(`Save dialog: failed (${saveErr?.code || saveErr?.message || "unknown"})`);
        }
      } else {
        attemptLog.push("Save dialog: not available in this view");
      }
    } catch (useErr) {
      attemptLog.push(`Save dialog: unavailable (${useErr?.message || "unknown"})`);
    }
  } else {
    attemptLog.push("Save dialog: not present in this context");
  }

  try {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = dlUrl;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(dlUrl), 4000);
    return { ok: true, via: "anchor", attemptLog: [...attemptLog, "Browser download: triggered"] };
  } catch (dlErr) {
    attemptLog.push(`Browser download: failed (${dlErr?.message || "unknown"})`);
  }

  try {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const dlUrl = URL.createObjectURL(blob);
    const opened = window.open(dlUrl, "_blank", "noopener");
    if (opened) {
      return {
        ok: true,
        via: "new-tab",
        attemptLog: [...attemptLog, "Opened in a new tab - use your browser's Save/Share to keep it"],
      };
    }
    attemptLog.push("Open in new tab: blocked by the browser");
  } catch (openErr) {
    attemptLog.push(`Open in new tab: failed (${openErr?.message || "unknown"})`);
  }

  return { ok: false, attemptLog };
}
