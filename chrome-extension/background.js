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
  // Only ever appears when text is actually selected — an occasional option,
  // not something always in the menu.
  chrome.contextMenus.create({
    id: "read-selection",
    title: "Read selected text aloud",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "read-selection") {
    readSelectionInPlace(tab.id, info.selectionText);
    return;
  }
  const url = info.linkUrl || info.pageUrl || tab?.url;
  if (url) sendPdfToApp(url);
});

// The toolbar icon opens popup.html (explicit choices: read this page, read a
// selection, or send a PDF), so there's no chrome.action.onClicked handler
// here — Chrome doesn't fire that event once a default_popup is set.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "send-pdf" && message.url) {
    sendPdfToApp(message.url);
  } else if (message?.action === "read-page" && message.tabId) {
    readPageInPlace(message.tabId);
  } else if (message?.action === "read-selection" && message.text && message.tabId) {
    readSelectionInPlace(message.tabId, message.text);
  }
  return false;
});

// ---------- Read this page / read selection: happens right on the page ----------
// No app tab, no messaging — a floating player is injected directly into the
// page you're viewing, so you can follow along on the actual page.

async function readPageInPlace(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: startInPageReader,
      args: [{ mode: "auto" }],
    });
    flashBadge("✓", "#2e7d32");
  } catch (err) {
    console.error("Read Aloud extension: failed to read this page", err);
    flashBadge("!", "#a8492a");
  }
}

async function readSelectionInPlace(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: startInPageReader,
      args: [{ mode: "text", text }],
    });
    flashBadge("✓", "#2e7d32");
  } catch (err) {
    console.error("Read Aloud extension: failed to read selection", err);
    flashBadge("!", "#a8492a");
  }
}

// Runs INSIDE the page being read (via chrome.scripting.executeScript), so it
// must be fully self-contained — no references to anything outside this
// function's own body (the function is serialized and re-run in the page,
// closures don't survive that trip).
function startInPageReader(payload) {
  try {
    let text = "";
    if (payload && payload.mode === "text" && payload.text) {
      text = payload.text;
    } else {
      // Strip common clutter containers (nav/header/footer/aside, tables of
      // contents, edit links) from a CLONE before measuring/reading text, so
      // things like a page's table-of-contents sidebar aren't read first.
      const CLUTTER_SELECTORS =
        "nav, header, footer, aside, [role='navigation'], [role='banner'], " +
        "[role='contentinfo'], .toc, #toc, .vector-toc, .vector-page-toolbar, " +
        ".navbox, .mw-editsection, script, style, noscript";
      const cleanText = (el) => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll(CLUTTER_SELECTORS).forEach((n) => n.remove());
        return (clone.innerText || "").trim();
      };

      let best = null;
      let bestLen = 0;
      document.querySelectorAll("article, main, [role='main']").forEach((el) => {
        const len = cleanText(el).length;
        if (len > bestLen) {
          bestLen = len;
          best = el;
        }
      });
      if (!best || bestLen < 200) {
        const bodyLen = cleanText(document.body).length;
        document.querySelectorAll("div, section").forEach((el) => {
          const len = cleanText(el).length;
          if (len > bestLen && len < bodyLen * 0.95) {
            bestLen = len;
            best = el;
          }
        });
      }
      text = cleanText(best || document.body);
    }
    text = (text || "").trim();
    if (!text || text.length < 20) {
      alert("Read Aloud: couldn't find readable text here.");
      return;
    }

    function splitSentences(t) {
      const masked = t.replace(/(\d)\.(\d)/g, "$1$2");
      const matches = masked.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [];
      return matches.map((s) => s.replace(//g, ".").trim()).filter(Boolean);
    }
    const sentences = splitSentences(text);
    if (!sentences.length) {
      alert("Read Aloud: couldn't find readable text here.");
      return;
    }

    const prevHost = document.getElementById("__read_aloud_overlay_host__");
    if (prevHost) {
      window.speechSynthesis.cancel();
      prevHost.remove();
    }

    const host = document.createElement("div");
    host.id = "__read_aloud_overlay_host__";
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .bar {
          position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
          z-index: 2147483647; background: #201f25; color: #ece9e2;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,0.4);
          padding: 10px 14px; width: min(92vw, 480px); box-sizing: border-box;
        }
        .row { display: flex; align-items: center; gap: 8px; }
        button {
          background: #a8492a; color: #fff; border: none; border-radius: 8px;
          padding: 6px 10px; cursor: pointer; font-size: 13px; font-family: inherit; line-height: 1;
        }
        button.secondary { background: #34323a; color: #ece9e2; }
        input[type=range] { flex: 1; accent-color: #a8492a; }
        .label { font-size: 11px; color: #9a958c; white-space: nowrap; }
        .text {
          font-size: 12.5px; color: #d8d3c9; margin-top: 8px; max-height: 4.2em;
          overflow: hidden; line-height: 1.4;
        }
        .close { margin-left: auto; background: none; color: #9a958c; font-size: 15px; padding: 2px 6px; }
      </style>
      <div class="bar">
        <div class="row">
          <button id="playpause" title="Play/Pause">▶</button>
          <button id="stop" class="secondary" title="Stop">⏹</button>
          <span class="label">Speed</span>
          <input id="rate" type="range" min="0.5" max="2.5" step="0.1" value="1" />
          <span class="label" id="rate-label">1.0×</span>
          <button id="close" class="close" title="Close">✕</button>
        </div>
        <div class="text" id="current-text"></div>
      </div>
    `;

    const playBtn = shadow.getElementById("playpause");
    const rateInput = shadow.getElementById("rate");
    const rateLabel = shadow.getElementById("rate-label");
    const textEl = shadow.getElementById("current-text");

    let idx = 0;
    let playing = false;

    function speak(i) {
      window.speechSynthesis.cancel();
      if (i >= sentences.length) {
        playing = false;
        playBtn.textContent = "▶";
        return;
      }
      idx = i;
      textEl.textContent = sentences[i];
      const u = new SpeechSynthesisUtterance(sentences[i]);
      u.rate = parseFloat(rateInput.value);
      u.onend = () => {
        if (playing) speak(i + 1);
      };
      window.speechSynthesis.speak(u);
    }

    playBtn.addEventListener("click", () => {
      if (playing) {
        window.speechSynthesis.pause();
        playing = false;
        playBtn.textContent = "▶";
      } else if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
        playing = true;
        playBtn.textContent = "⏸";
      } else {
        playing = true;
        playBtn.textContent = "⏸";
        speak(idx);
      }
    });

    shadow.getElementById("stop").addEventListener("click", () => {
      window.speechSynthesis.cancel();
      playing = false;
      playBtn.textContent = "▶";
      idx = 0;
      textEl.textContent = "";
    });

    rateInput.addEventListener("input", () => {
      rateLabel.textContent = parseFloat(rateInput.value).toFixed(1) + "×";
      if (playing) speak(idx);
    });

    shadow.getElementById("close").addEventListener("click", () => {
      window.speechSynthesis.cancel();
      host.remove();
    });

    playing = true;
    playBtn.textContent = "⏸";
    speak(0);
  } catch (err) {
    console.error("Read Aloud in-page reader error:", err);
    alert("Read Aloud couldn't read this page: " + err.message);
  }
}

// ---------- Send PDF to app: still uses the full app (parsing, library, etc.) ----------

async function sendPdfToApp(pdfUrl) {
  try {
    flashBadge("…");
    const res = await fetch(pdfUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const name = decodeURIComponent((pdfUrl.split("/").pop() || "document.pdf").split("?")[0]);

    await deliverToApp({ type: "incoming-pdf", name, buffer });
    flashBadge("✓", "#2e7d32");
  } catch (err) {
    console.error("Read Aloud extension: failed to send PDF", err);
    flashBadge("!", "#a8492a");
  }
}

// Finds (or opens) the app tab and delivers a message to its content script.
// If an existing tab doesn't respond (e.g. it was already open before the
// extension was last reloaded, so it never got the content script), reloads
// that tab and retries once instead of failing silently.
async function deliverToApp(message) {
  const existing = await chrome.tabs.query({ url: APP_URL + "*" });
  if (existing[0]) {
    await chrome.tabs.update(existing[0].id, { active: true });
    try {
      await sendMessageWithRetry(existing[0].id, message, 6, 200);
      return;
    } catch {
      await chrome.tabs.reload(existing[0].id);
      await waitForTabComplete(existing[0].id);
      await sendMessageWithRetry(existing[0].id, message);
      return;
    }
  }
  const tab = await chrome.tabs.create({ url: APP_URL });
  await waitForTabComplete(tab.id);
  await sendMessageWithRetry(tab.id, message);
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
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
