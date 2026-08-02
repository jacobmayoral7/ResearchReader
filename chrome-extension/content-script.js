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
