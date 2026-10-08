// Bridges messages from the extension's background script (isolated world)
// into the page itself (main world), where app.js listens for them.
const RELAY_TYPES = ["incoming-pdf", "incoming-page-text"];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && RELAY_TYPES.includes(message.type)) {
    window.postMessage({ source: "read-aloud-extension", ...message }, window.location.origin);
    sendResponse({ ok: true });
  }
  return true;
});

// Chrome has one speech queue for the whole browser, so only one Read Aloud
// player may speak at a time. When the app starts reading it tells us (via
// postMessage); we publish that as a "claim" so the extension's in-page players
// stop. And when an extension player claims, we tell the app to stop.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (d && d.source === "read-aloud-app" && d.type === "claim") {
    try { chrome.storage.local.set({ speechClaim: { id: "app", t: Date.now() } }); } catch (e) {}
  }
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    const claim = area === "local" && changes.speechClaim && changes.speechClaim.newValue;
    if (claim && String(claim.id).startsWith("ext-")) {
      window.postMessage({ source: "read-aloud-extension", type: "stop-speech" }, window.location.origin);
    }
  });
} catch (e) {}
