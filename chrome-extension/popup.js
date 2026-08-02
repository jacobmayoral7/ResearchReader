const statusEl = document.getElementById("status");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.getElementById("read-page").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  statusEl.textContent = "Sending page to Read Aloud…";
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
