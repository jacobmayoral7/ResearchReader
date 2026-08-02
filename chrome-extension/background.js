const APP_URL = "https://jacobmayoral7.github.io/ResearchReader/";
const PDF_PATTERNS = ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.pdf#*"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send-pdf-link",
    title: "Send PDF to Read Aloud",
    contexts: ["link"],
    targetUrlPatterns: PDF_PATTERNS,
  });
  chrome.contextMenus.create({
    id: "send-pdf-page",
    title: "Send this PDF to Read Aloud",
    contexts: ["page"],
    documentUrlPatterns: PDF_PATTERNS,
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.pageUrl || tab?.url;
  if (url) sendPdfToApp(url);
});

// The toolbar icon opens popup.html (two explicit choices: read this page, or
// send a PDF), so there's no chrome.action.onClicked handler here — Chrome
// doesn't fire that event once a default_popup is set.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "send-pdf" && message.url) {
    sendPdfToApp(message.url);
  } else if (message?.action === "read-page" && message.tabId) {
    sendPageTextToApp(message.tabId);
  }
  return false;
});

async function sendPdfToApp(pdfUrl) {
  try {
    flashBadge("…");
    const res = await fetch(pdfUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const name = decodeURIComponent((pdfUrl.split("/").pop() || "document.pdf").split("?")[0]);

    const tab = await findOrOpenAppTab();
    await sendMessageWithRetry(tab.id, { type: "incoming-pdf", name, buffer });
    flashBadge("✓", "#2e7d32");
  } catch (err) {
    console.error("Read Aloud extension: failed to send PDF", err);
    flashBadge("!", "#a8492a");
  }
}

async function sendPageTextToApp(sourceTabId) {
  try {
    flashBadge("…");
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: sourceTabId },
      func: extractPageText,
    });
    if (!result || !result.text || result.text.trim().length < 40) {
      throw new Error("No readable text found on this page");
    }

    const appTab = await findOrOpenAppTab();
    await sendMessageWithRetry(appTab.id, {
      type: "incoming-page-text",
      title: result.title || "Untitled Page",
      text: result.text,
    });
    flashBadge("✓", "#2e7d32");
  } catch (err) {
    console.error("Read Aloud extension: failed to read page", err);
    flashBadge("!", "#a8492a");
  }
}

// Runs inside the page being read (via chrome.scripting.executeScript), so it
// can only reference the DOM — no access to anything else in this file.
// Lightweight "reader mode": prefer <article>/<main>, else the largest text
// block that isn't essentially the whole page (nav/sidebar/footer clutter).
function extractPageText() {
  function textLen(el) {
    return (el.innerText || "").trim().length;
  }
  let best = null;
  let bestLen = 0;
  document.querySelectorAll("article, main, [role='main']").forEach((el) => {
    const len = textLen(el);
    if (len > bestLen) {
      bestLen = len;
      best = el;
    }
  });
  if (!best || bestLen < 200) {
    const bodyLen = textLen(document.body);
    document.querySelectorAll("div, section").forEach((el) => {
      const len = textLen(el);
      if (len > bestLen && len < bodyLen * 0.95) {
        bestLen = len;
        best = el;
      }
    });
  }
  const text = (best || document.body).innerText || "";
  return { title: document.title, text: text.trim() };
}

async function findOrOpenAppTab() {
  const existing = await chrome.tabs.query({ url: APP_URL + "*" });
  if (existing[0]) {
    await chrome.tabs.update(existing[0].id, { active: true });
    return existing[0];
  }
  const tab = await chrome.tabs.create({ url: APP_URL });
  await new Promise((resolve) => {
    function listener(id, info) {
      if (id === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab;
}

// The content script's message listener may not be registered the instant
// the tab reports "complete", so retry briefly instead of failing outright.
async function sendMessageWithRetry(tabId, message, retries = 8, delayMs = 250) {
  for (let i = 0; i < retries; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function flashBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
  if (text !== "…") setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}
