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
// selection, pick paragraphs, or send a PDF), so there's no
// chrome.action.onClicked handler here — Chrome doesn't fire that event once
// a default_popup is set.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "send-pdf" && message.url) {
    sendPdfToApp(message.url);
  } else if (message?.action === "read-page" && message.tabId) {
    readPageInPlace(message.tabId);
  } else if (message?.action === "read-selection" && message.text && message.tabId) {
    readSelectionInPlace(message.tabId, message.text);
  } else if (message?.action === "pick-paragraphs" && message.tabId) {
    pickParagraphsInPlace(message.tabId);
  }
  return false;
});

// ---------- Read this page / read selection / pick paragraphs: all happen
// right on the page. No app tab, no messaging — a floating player (or picker)
// is injected directly into the page you're viewing.

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

async function pickParagraphsInPlace(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: startInPageReader,
      args: [{ mode: "pick" }],
    });
    flashBadge("✓", "#2e7d32");
  } catch (err) {
    console.error("Read Aloud extension: failed to start paragraph picker", err);
    flashBadge("!", "#a8492a");
  }
}

// Runs INSIDE the page being read (via chrome.scripting.executeScript), so it
// must be fully self-contained — no references to anything outside this
// function's own body (the function is serialized and re-run in the page,
// closures don't survive that trip).
function startInPageReader(payload) {
  try {
    // Clear any previous overlay/picker state so repeat invocations don't
    // stack listeners or leave stale UI behind.
    const prevHost = document.getElementById("__read_aloud_overlay_host__");
    if (prevHost) {
      window.speechSynthesis.cancel();
      prevHost.remove();
    }
    if (window.__readAloudPickerCleanup__) {
      window.__readAloudPickerCleanup__();
      window.__readAloudPickerCleanup__ = null;
    }

    // Shared clutter exclusion: nav/header/footer/aside, tables of contents,
    // edit links — used both to keep these out of "read this page" and to
    // keep TOC/menu list items out of the paragraph picker's candidates.
    var CLUTTER_SELECTORS =
      "nav, header, footer, aside, [role='navigation'], [role='banner'], " +
      "[role='contentinfo'], .toc, #toc, .vector-toc, .vector-page-toolbar, " +
      ".navbox, .mw-editsection, script, style, noscript";

    var DOT_PLACEHOLDER = String.fromCharCode(1);
    function splitSentences(t) {
      const masked = t.replace(/(\d)\.(\d)/g, "$1" + DOT_PLACEHOLDER + "$2");
      const matches = masked.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [];
      return matches
        .map((s) => s.split(DOT_PLACEHOLDER).join(".").trim())
        .filter(Boolean);
    }

    const BAR_STYLE =
      ".bar { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);" +
      " z-index: 2147483647; background: #201f25; color: #ece9e2;" +
      " font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;" +
      " border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,0.4);" +
      " padding: 10px 14px; width: min(92vw, 480px); box-sizing: border-box; }" +
      ".row { display: flex; align-items: center; gap: 8px; }" +
      "button { background: #a8492a; color: #fff; border: none; border-radius: 8px;" +
      " padding: 6px 10px; cursor: pointer; font-size: 13px; font-family: inherit; line-height: 1; }" +
      "button:disabled { opacity: 0.4; cursor: default; }" +
      "button.secondary { background: #34323a; color: #ece9e2; }" +
      "input[type=range] { flex: 1; accent-color: #a8492a; }" +
      ".label { font-size: 11px; color: #9a958c; white-space: nowrap; }" +
      ".hint { font-size: 11.5px; color: #9a958c; margin-top: 8px; line-height: 1.4; }" +
      ".text { font-size: 12.5px; color: #d8d3c9; margin-top: 8px; max-height: 4.2em;" +
      " overflow: hidden; line-height: 1.4; }" +
      ".close { margin-left: auto; background: none; color: #9a958c; font-size: 15px; padding: 2px 6px; }";

    function makeOverlay() {
      const host = document.createElement("div");
      host.id = "__read_aloud_overlay_host__";
      document.documentElement.appendChild(host);
      return { host: host, shadow: host.attachShadow({ mode: "open" }) };
    }

    // ---- Reading UI: play/pause/stop/speed over a fixed list of sentences ----
    function startReadingSentences(sentences) {
      const ov = makeOverlay();
      const host = ov.host;
      const shadow = ov.shadow;
      shadow.innerHTML =
        "<style>" + BAR_STYLE + "</style>" +
        '<div class="bar">' +
        '<div class="row">' +
        '<button id="playpause" title="Play/Pause">▶</button>' +
        '<button id="stop" class="secondary" title="Stop">⏹</button>' +
        '<span class="label">Speed</span>' +
        '<input id="rate" type="range" min="0.5" max="2.5" step="0.1" value="1" />' +
        '<span class="label" id="rate-label">1.0×</span>' +
        '<button id="close" class="close" title="Close">✕</button>' +
        "</div>" +
        '<div class="text" id="current-text"></div>' +
        "</div>";

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
        u.onend = function () {
          if (playing) speak(i + 1);
        };
        window.speechSynthesis.speak(u);
      }

      playBtn.addEventListener("click", function () {
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

      shadow.getElementById("stop").addEventListener("click", function () {
        window.speechSynthesis.cancel();
        playing = false;
        playBtn.textContent = "▶";
        idx = 0;
        textEl.textContent = "";
      });

      rateInput.addEventListener("input", function () {
        rateLabel.textContent = parseFloat(rateInput.value).toFixed(1) + "×";
        if (playing) speak(idx);
      });

      shadow.getElementById("close").addEventListener("click", function () {
        window.speechSynthesis.cancel();
        host.remove();
      });

      playing = true;
      playBtn.textContent = "⏸";
      speak(0);
    }

    // ---- Paragraph picker: click paragraphs to queue them, in click order ----
    function startParagraphPicker() {
      function isCandidate(el) {
        if ((el.innerText || "").trim().length <= 15) return false;
        if (el.closest(CLUTTER_SELECTORS)) return false;
        return true;
      }

      // Semantic tags AND leaf-like <div>/<span> blocks are both included
      // (not "div as a last resort") — many sites (academic publishers
      // especially) wrap real body paragraphs in styled divs while still
      // having plenty of unrelated <p> tags elsewhere (legal text, hidden
      // accessibility banners), so "zero <p> found" is the wrong trigger.
      const semantic = Array.prototype.filter.call(
        document.querySelectorAll("p, li, blockquote, dd, td, figcaption"),
        isCandidate
      );
      const leafBlocks = Array.prototype.filter.call(document.querySelectorAll("div, span"), function (el) {
        if (!isCandidate(el)) return false;
        if (el.querySelector("div, p, section, article, ul, ol, table, blockquote")) return false;
        return true;
      });
      const candidates = semantic.concat(leafBlocks);

      if (candidates.length === 0) {
        alert(
          "Read Aloud: couldn't find any paragraphs to pick on this page. Try \"Read this page aloud\" instead, or select some text and use \"Read selected text.\""
        );
        return;
      }

      // Click/hover detection uses real geometry (getClientRects — the
      // actual per-line boxes), not native event targeting or a plain
      // bounding box. Some sites style their paragraph container as
      // `display: inline`; for an inline element wrapping across multiple
      // lines, the bounding box includes gaps between lines that aren't
      // actually part of the element for hit-testing, so a click there
      // natively lands on the parent instead — this is what made clicking
      // silently do nothing on pages like MDPI's article layout.
      // A few px of padding absorbs the small inter-line leading gap so a
      // click that lands just between two lines of the same paragraph still
      // registers, without being loose enough to false-match a neighbor.
      const HIT_PAD = 3;
      function candidateAtPoint(x, y) {
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i];
          const rects = el.getClientRects();
          for (let j = 0; j < rects.length; j++) {
            const r = rects[j];
            if (x >= r.left - HIT_PAD && x <= r.right + HIT_PAD && y >= r.top - HIT_PAD && y <= r.bottom + HIT_PAD) return el;
          }
        }
        return null;
      }

      const style = document.createElement("style");
      style.textContent =
        ".__read_aloud_hover__ { background-color: rgba(168,73,42,0.12) !important;" +
        " outline: 2px dashed rgba(168,73,42,0.55) !important; outline-offset: 2px; }" +
        ".__read_aloud_selected__ { background-color: rgba(168,73,42,0.18) !important;" +
        " outline: 2px solid #a8492a !important; outline-offset: 2px; }" +
        ".__read_aloud_badge__ { display: inline-flex !important; align-items: center !important;" +
        " justify-content: center !important; min-width: 20px !important; height: 20px !important;" +
        " padding: 0 5px !important; margin-right: 6px !important; background: #a8492a !important;" +
        " color: #fff !important; border-radius: 999px !important; font-size: 12px !important;" +
        " font-family: sans-serif !important; font-weight: 700 !important; vertical-align: middle !important;" +
        " line-height: 20px !important;";
      document.head.appendChild(style);

      const order = []; // { el, badge }, in click order
      let hovered = null;

      function updateBar() {
        countLabel.textContent = order.length === 1 ? "1 selected" : order.length + " selected";
        playBtn.disabled = order.length === 0;
      }

      function renumber() {
        order.forEach(function (item, i) {
          item.badge.textContent = String(i + 1);
        });
        updateBar();
      }

      function toggle(el) {
        const idx = order.findIndex(function (item) {
          return item.el === el;
        });
        if (idx >= 0) {
          order[idx].badge.remove();
          el.classList.remove("__read_aloud_selected__");
          order.splice(idx, 1);
          renumber();
        } else {
          const badge = document.createElement("span");
          badge.className = "__read_aloud_badge__";
          badge.textContent = String(order.length + 1);
          el.classList.add("__read_aloud_selected__");
          el.insertBefore(badge, el.firstChild);
          order.push({ el: el, badge: badge });
          updateBar();
        }
      }

      // Coalesced to one check per animation frame instead of on every
      // mousemove — scanning several hundred candidates' getClientRects()
      // on every single mousemove event would be needlessly heavy.
      let pendingPoint = null;
      let rafScheduled = false;
      function onMouseMove(e) {
        pendingPoint = { x: e.clientX, y: e.clientY };
        if (rafScheduled) return;
        rafScheduled = true;
        requestAnimationFrame(function () {
          rafScheduled = false;
          if (!pendingPoint) return;
          const hit = candidateAtPoint(pendingPoint.x, pendingPoint.y);
          if (hit !== hovered) {
            if (hovered) hovered.classList.remove("__read_aloud_hover__");
            if (hit) hit.classList.add("__read_aloud_hover__");
            hovered = hit;
          }
          document.body.style.cursor = hit ? "pointer" : "";
        });
      }

      function onClick(e) {
        const hit = candidateAtPoint(e.clientX, e.clientY);
        if (!hit) return; // not on a candidate — let the click behave normally
        e.preventDefault();
        e.stopPropagation();
        toggle(hit);
      }

      document.addEventListener("mousemove", onMouseMove, true);
      document.addEventListener("click", onClick, true);

      const ov = makeOverlay();
      const host = ov.host;
      const shadow = ov.shadow;
      shadow.innerHTML =
        "<style>" + BAR_STYLE + "</style>" +
        '<div class="bar">' +
        '<div class="row">' +
        '<span class="label" id="count-label">0 selected</span>' +
        '<button id="play" disabled>▶ Play</button>' +
        '<button id="cancel" class="secondary">✕ Cancel</button>' +
        "</div>" +
        '<div class="hint">Click paragraphs to queue them, in the order you click. Click one again to remove it.</div>' +
        "</div>";

      const countLabel = shadow.getElementById("count-label");
      const playBtn = shadow.getElementById("play");

      function cleanup() {
        document.removeEventListener("mousemove", onMouseMove, true);
        document.removeEventListener("click", onClick, true);
        document.body.style.cursor = "";
        if (hovered) hovered.classList.remove("__read_aloud_hover__");
        order.forEach(function (item) {
          item.badge.remove();
          item.el.classList.remove("__read_aloud_selected__");
        });
        style.remove();
        host.remove();
      }
      window.__readAloudPickerCleanup__ = cleanup;

      playBtn.addEventListener("click", function () {
        // Read from a clone with the number badge stripped out, so the badge
        // text ("1", "2", ...) doesn't leak into the extracted paragraph text.
        const texts = order
          .map(function (item) {
            const clone = item.el.cloneNode(true);
            const badge = clone.querySelector(".__read_aloud_badge__");
            if (badge) badge.remove();
            return (clone.innerText || "").trim();
          })
          .filter(Boolean);
        cleanup();
        window.__readAloudPickerCleanup__ = null;
        const sentences = splitSentences(texts.join("\n\n"));
        if (sentences.length) startReadingSentences(sentences);
      });

      shadow.getElementById("cancel").addEventListener("click", function () {
        cleanup();
        window.__readAloudPickerCleanup__ = null;
      });
    }

    // ---- Dispatch ----
    if (payload && payload.mode === "pick") {
      startParagraphPicker();
      return;
    }

    let text = "";
    if (payload && payload.mode === "text" && payload.text) {
      text = payload.text;
    } else {
      // Strip common clutter containers from a CLONE before measuring/reading
      // text, so things like a page's table-of-contents sidebar aren't read
      // first (CLUTTER_SELECTORS is shared with the paragraph picker above).
      const cleanText = function (el) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll(CLUTTER_SELECTORS).forEach(function (n) {
          n.remove();
        });
        return (clone.innerText || "").trim();
      };

      let best = null;
      let bestLen = 0;
      document.querySelectorAll("article, main, [role='main']").forEach(function (el) {
        const len = cleanText(el).length;
        if (len > bestLen) {
          bestLen = len;
          best = el;
        }
      });
      if (!best || bestLen < 200) {
        const bodyLen = cleanText(document.body).length;
        document.querySelectorAll("div, section").forEach(function (el) {
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
    const sentences = splitSentences(text);
    if (!sentences.length) {
      alert("Read Aloud: couldn't find readable text here.");
      return;
    }
    startReadingSentences(sentences);
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
