const statusEl = document.getElementById("status");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.getElementById("read-page").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  statusEl.textContent = "Reading this page…";
  // Fire-and-forget: the background service worker does the actual work so it
  // keeps running even after this popup closes.
  chrome.runtime.sendMessage({ action: "read-page", tabId: tab.id });
  setTimeout(() => window.close(), 400);
});

document.getElementById("send-pdf").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.url) return;
  statusEl.textContent = "Sending PDF to Read Aloud…";
  chrome.runtime.sendMessage({ action: "send-pdf", url: tab.url });
  setTimeout(() => window.close(), 400);
});

// Only show "Read selected text" if the page actually has a selection right
// now — an occasional option, not a permanent fixture of the popup.
(async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() || "",
    });
    if (result && result.trim()) {
      const btn = document.getElementById("read-selection");
      btn.hidden = false;
      btn.addEventListener("click", () => {
        statusEl.textContent = "Reading selection…";
        chrome.runtime.sendMessage({ action: "read-selection", text: result, tabId: tab.id });
        setTimeout(() => window.close(), 400);
      });
    }
  } catch {
    // Some pages (chrome://, the Chrome Web Store, etc.) block script injection — ignore.
  }
})();
