// ---------- Setup ----------
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// Enables "Add to Home Screen" installability and offline use.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(err => console.error("SW registration failed:", err));
  });
}

const DB_NAME = "read-aloud-db";
const DB_VERSION = 1;
const STORE = "documents";

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(doc) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(doc);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- State ----------
const state = {
  docs: [],
  currentDoc: null,
  idx: 0,
  isPlaying: false,
  voices: [],
};

const els = {};
[
  "library-view", "reader-view", "file-input", "upload-progress",
  "upload-progress-fill", "empty-state", "doc-grid", "back-btn",
  "reader-title", "reading-pane", "progress-text", "reader-progress-fill",
  "play-btn", "stop-btn", "prev-btn", "next-btn", "rate-slider", "rate-value",
  "pitch-slider", "pitch-value", "voice-select", "theme-toggle", "theme-toggle-2",
  "font-inc", "font-dec", "skip-parens", "skip-extras",
  "url-form", "url-input", "url-status",
].forEach(id => { els[id] = document.getElementById(id); });

// ---------- Theme ----------
function initTheme() {
  const saved = localStorage.getItem("ra-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("ra-theme", next);
}

els["theme-toggle"].addEventListener("click", toggleTheme);
els["theme-toggle-2"].addEventListener("click", toggleTheme);

// ---------- Font size ----------
function changeFontSize(delta) {
  const root = document.documentElement;
  const current = parseInt(getComputedStyle(root).getPropertyValue("--reading-font-size")) || 20;
  const next = Math.min(32, Math.max(14, current + delta));
  root.style.setProperty("--reading-font-size", next + "px");
  localStorage.setItem("ra-font-size", next);
}
els["font-inc"].addEventListener("click", () => changeFontSize(2));
els["font-dec"].addEventListener("click", () => changeFontSize(-2));

function initFontSize() {
  const saved = localStorage.getItem("ra-font-size");
  if (saved) document.documentElement.style.setProperty("--reading-font-size", saved + "px");
}

// ---------- Sentence splitting ----------
// Common academic abbreviations whose periods shouldn't be treated as sentence
// endings (otherwise "et al." or "p." would wrongly split the sentence).
const ABBREVIATIONS = [
  "et al.", "e.g.", "i.e.", "cf.", "vs.", "approx.", "Fig.", "Eq.", "No.",
  "Vol.", "pp.", "p.", "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Inc.", "Ltd.",
  "Jr.", "Sr.", "St.", "etc.",
];
const SENTENCE_SPLIT_PLACEHOLDER = "";

function splitSentences(text) {
  let masked = text;

  // Protect decimal points, including leading-dot stats notation (p < .001, d = .62),
  // from being mistaken for sentence-ending periods.
  masked = masked.replace(/(\d)\.(\d)/g, `$1${SENTENCE_SPLIT_PLACEHOLDER}$2`);
  masked = masked.replace(/([\s(=<>])\.(\d)/g, `$1${SENTENCE_SPLIT_PLACEHOLDER}$2`);

  ABBREVIATIONS.forEach(abbr => {
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");
    masked = masked.replace(re, m => m.slice(0, -1) + SENTENCE_SPLIT_PLACEHOLDER);
  });

  const matches = masked.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g);
  if (!matches) return [];
  const unmask = new RegExp(SENTENCE_SPLIT_PLACEHOLDER, "g");
  return matches.map(s => s.replace(unmask, ".").trim()).filter(Boolean);
}

// Removes parenthetical asides (inline stats like "(r = .05, d = .2)", citations
// like "(Smith et al., 2020)") and bracketed citation markers (like "[12]" or
// "[12,13]") from text before it's spoken. Display text is left untouched.
function stripCitationsAndAsides(text) {
  let result = text;
  let prev;
  // Loop so nested groups like "(F(1, 243) = 12.4, p < .001)" fully strip
  // (each pass only removes the innermost, unnested group).
  do {
    prev = result;
    result = result.replace(/\([^()]*\)/g, "");
  } while (result !== prev);
  do {
    prev = result;
    result = result.replace(/\[[^\[\]]*\]/g, "");
  } while (result !== prev);

  return result
    .replace(/\s+([,.;:!?])(?!\d)/g, "$1") // don't touch decimals like "< .001"
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------- PDF extraction ----------
// Groups a page's text items into lines using their y-position, tracking each
// line's font size (for heading detection) and boldness.
function groupItemsIntoLines(items, pageNum) {
  const lines = [];
  let current = null;
  let lastY = null;
  let lastEndX = null;
  const Y_TOL = 2;

  items.forEach(item => {
    const str = item.str;
    if (!str || !str.trim()) {
      // A whitespace-only item is an explicit space between words.
      if (current && str) current.text += " ";
      if (item.hasEOL && current) { lines.push(current); current = null; lastY = null; lastEndX = null; }
      return;
    }
    const x = item.transform[4];
    const y = item.transform[5];
    const fontSize = Math.hypot(item.transform[2], item.transform[3]) || item.height || 0;
    const bold = /bold/i.test(item.fontName || "");
    const endX = x + (item.width || 0);

    if (current && lastY !== null && Math.abs(y - lastY) <= Y_TOL) {
      // Some PDFs emit each glyph/word as a separate, tightly-kerned item with no
      // whitespace item between them (e.g. small-caps headers). Only insert a space
      // when there's an actual visible gap, so "J OINT P OSITION" doesn't happen.
      const gap = lastEndX === null ? 0 : x - lastEndX;
      const needsSpace = gap > fontSize * 0.15;
      const alreadyHasSpace = current.text.endsWith(" ") || str.startsWith(" ");
      current.text += (needsSpace && !alreadyHasSpace ? " " : "") + str;
      current.fontSize = Math.max(current.fontSize, fontSize);
      current.bold = current.bold || bold;
    } else {
      if (current) lines.push(current);
      current = { text: str, page: pageNum, fontSize, bold };
    }
    lastY = y;
    lastEndX = endX;
    if (item.hasEOL) {
      lines.push(current);
      current = null;
      lastY = null;
      lastEndX = null;
    }
  });
  if (current) lines.push(current);

  return lines
    .map(l => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }))
    .filter(l => l.text);
}

// The most common font size (weighted by text length) is treated as body text size.
function computeBodyFontSize(lines) {
  const counts = new Map();
  lines.forEach(l => {
    const rounded = Math.round(l.fontSize * 2) / 2;
    counts.set(rounded, (counts.get(rounded) || 0) + l.text.length);
  });
  let best = 12, bestCount = -1;
  counts.forEach((count, size) => {
    if (count > bestCount) { bestCount = count; best = size; }
  });
  return best;
}

function isHeadingLine(line, bodySize) {
  const wordCount = line.text.split(/\s+/).length;
  if (wordCount > 20) return false;
  const sizeRatio = line.fontSize / (bodySize || 1);
  if (sizeRatio >= 1.15) return true;
  if (line.bold && sizeRatio >= 0.98 && wordCount <= 12) return true;
  return false;
}

// Running headers/footers, copyright lines, DOIs, page numbers, journal/volume
// info, and submission-date lines — the administrative clutter around a paper,
// not its content.
const BOILERPLATE_PATTERNS = [
  /copyright/i,
  /all rights reserved/i,
  /^©/,
  /\bdoi\.org\b/i,
  /\b10\.\d{4,9}\/\S+/,
  /\bissn\b/i,
  /downloaded from/i,
  /terms and conditions/i,
  /creativecommons/i,
  /licen[sc]e/i,
  /^vol(ume)?\.?\s*\d+/i,
  /^no\.?\s*\d+(,|\s|$)/i,
  /^\d{1,4}$/,
  /\b(received|accepted|revised|submitted|published)\b.{0,30}\b(19|20)\d{2}\b/i,
];

function isBoilerplateLine(text, repeatCount, totalPages) {
  if (BOILERPLATE_PATTERNS.some(re => re.test(text))) return true;
  // A short line that repeats verbatim (aside from page numbers) across 2+ pages
  // is almost always a running header/footer, not real content.
  const wordCount = text.split(/\s+/).length;
  if (totalPages >= 2 && repeatCount >= 2 && wordCount <= 20) return true;
  return false;
}

// Classifies every line into title / author / heading / boilerplate / body,
// so playback can announce headings and skip the non-content parts.
function buildSentences(lines, bodySize, totalPages) {
  const repeatMap = new Map();
  lines.forEach(l => {
    const key = l.text.toLowerCase().replace(/\d+/g, "#").trim();
    if (!repeatMap.has(key)) repeatMap.set(key, new Set());
    repeatMap.get(key).add(l.page);
  });

  const sentences = [];
  let phase = "before-title"; // page-1 only: before-title -> front-matter -> done
  let currentPage = null;

  // Consecutive body lines are just typographic line-wraps within a paragraph —
  // buffer them and split into sentences together, so a sentence spanning a
  // line-wrap doesn't get cut into fragments at every line break.
  let bodyBuffer = [];
  function flushBody() {
    if (!bodyBuffer.length) return;
    const text = bodyBuffer.map(b => b.text).join(" ");
    const page = bodyBuffer[bodyBuffer.length - 1].page;
    splitSentences(text).forEach(s => sentences.push({ text: s, page, type: "body" }));
    bodyBuffer = [];
  }

  lines.forEach(line => {
    if (line.page !== currentPage) {
      currentPage = line.page;
      if (currentPage !== 1) phase = "done";
    }

    const key = line.text.toLowerCase().replace(/\d+/g, "#").trim();
    const repeatCount = repeatMap.get(key)?.size || 0;

    if (isBoilerplateLine(line.text, repeatCount, totalPages)) {
      flushBody();
      sentences.push({ text: line.text, page: line.page, type: "boilerplate" });
      return;
    }

    const heading = isHeadingLine(line, bodySize);

    if (line.page === 1 && phase === "before-title") {
      if (heading) {
        flushBody();
        sentences.push({ text: line.text, page: line.page, type: "title" });
        phase = "front-matter";
      } else {
        bodyBuffer.push(line);
      }
      return;
    }

    if (line.page === 1 && phase === "front-matter") {
      if (heading) {
        flushBody();
        sentences.push({ text: line.text, page: line.page, type: "heading" });
        phase = "done";
      } else if (line.text.split(/\s+/).length <= 20) {
        flushBody();
        sentences.push({ text: line.text, page: line.page, type: "author" });
      } else {
        phase = "done";
        bodyBuffer.push(line);
      }
      return;
    }

    if (heading) {
      flushBody();
      sentences.push({ text: line.text, page: line.page, type: "heading" });
    } else {
      bodyBuffer.push(line);
    }
  });

  flushBody();
  return sentences;
}

async function extractPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const allLines = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    allLines.push(...groupItemsIntoLines(content.items, pageNum));

    const pct = Math.round((pageNum / pdf.numPages) * 100);
    els["upload-progress-fill"].style.width = pct + "%";
  }

  const bodySize = computeBodyFontSize(allLines);
  const sentences = buildSentences(allLines, bodySize, pdf.numPages);

  return { sentences, totalPages: pdf.numPages };
}

// ---------- Upload flow ----------
async function saveAndOpenDoc(title, sentences, totalPages) {
  const doc = {
    id: crypto.randomUUID(),
    title: title || "Untitled",
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
    sentences,
    totalPages,
    position: 0,
  };
  await dbPut(doc);
  state.docs.push(doc);
  renderLibrary();
  openReader(doc.id);
}

// Shared by the file picker, the "paste a link" fetcher, and incoming PDFs
// handed off from the Chrome extension.
async function ingestFile(file, titleHint) {
  els["upload-progress"].classList.remove("hidden");
  els["upload-progress-fill"].style.width = "0%";

  try {
    const { sentences, totalPages } = await extractPdf(file);
    await saveAndOpenDoc((titleHint || file.name).replace(/\.pdf$/i, ""), sentences, totalPages);
    return true;
  } catch (err) {
    console.error(err);
    alert("Couldn't read that PDF. It may be scanned/image-only (no selectable text) or corrupted.");
    return false;
  } finally {
    els["upload-progress"].classList.add("hidden");
  }
}

// A page of plain web text (from the Chrome extension's "Read this page
// aloud" button) has no font-size data, so it's just one flat "body" flow —
// no heading/title/boilerplate detection, unlike PDFs.
async function ingestPlainText(title, text) {
  const sentences = splitSentences(text).map(s => ({ text: s, page: 1, type: "body" }));
  if (!sentences.length) {
    alert("Couldn't find readable text on that page.");
    return false;
  }
  await saveAndOpenDoc(title, sentences, 1);
  return true;
}

els["file-input"].addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  ingestFile(file);
});

// ---------- Paste a link to a PDF or webpage (works in any browser, e.g. Safari) ----------
function titleFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    return last.replace(/\.pdf$/i, "") || "Untitled";
  } catch {
    return "Untitled";
  }
}

// Same clutter-exclusion list used by the Chrome extension's "read this page"
// mode. Kept in sync manually since this runs in a different context (a
// detached, unrendered document parsed from fetched HTML, not a live tab).
const HTML_CLUTTER_SELECTORS =
  "nav, header, footer, aside, [role='navigation'], [role='banner'], " +
  "[role='contentinfo'], .toc, #toc, .vector-toc, .vector-page-toolbar, " +
  ".navbox, .mw-editsection, script, style, noscript, template, svg";

// Extracts readable article text from a fetched HTML string. The document is
// parsed but never attached/rendered, so innerText (which depends on layout)
// isn't usable here — textContent is used instead, with a space inserted
// after each block-level element so words from adjacent tags don't run
// together. This can't see content that a page renders via client-side JS
// after load (React/Vue-style single-page apps) since we only have the raw
// HTML the server returned.
function extractReadableTextFromHTML(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const BLOCK_TAGS = "p, div, section, article, li, h1, h2, h3, h4, h5, h6, blockquote, tr, td, br";

  function cleanText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(HTML_CLUTTER_SELECTORS).forEach(n => n.remove());
    clone.querySelectorAll(BLOCK_TAGS).forEach(n => n.appendChild(doc.createTextNode(" ")));
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  let best = null;
  let bestLen = 0;
  doc.querySelectorAll("article, main, [role='main']").forEach(el => {
    const len = cleanText(el).length;
    if (len > bestLen) { bestLen = len; best = el; }
  });
  if (!best || bestLen < 200) {
    const bodyLen = cleanText(doc.body).length;
    doc.querySelectorAll("div, section").forEach(el => {
      const len = cleanText(el).length;
      if (len > bestLen && len < bodyLen * 0.95) { bestLen = len; best = el; }
    });
  }

  const title = (doc.querySelector("title")?.textContent || "").trim();
  return { title, text: cleanText(best || doc.body) };
}

els["url-form"].addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = els["url-input"].value.trim();
  if (!url) return;

  els["url-status"].textContent = "Fetching…";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    const looksLikePdf = contentType.includes("pdf") || /\.pdf(?:[?#]|$)/i.test(url);

    let ok;
    if (looksLikePdf) {
      const blob = await res.blob();
      const file = new File([blob], titleFromUrl(url) + ".pdf", { type: "application/pdf" });
      ok = await ingestFile(file, titleFromUrl(url));
    } else {
      const html = await res.text();
      const { title, text } = extractReadableTextFromHTML(html);
      ok = await ingestPlainText(title || titleFromUrl(url), text);
    }
    els["url-status"].textContent = "";
    if (ok) els["url-input"].value = "";
  } catch (err) {
    console.error(err);
    els["url-status"].textContent =
      "Couldn't fetch that link directly (the site may block cross-site requests, or it needs you to be logged in). " +
      "Try downloading/saving the content, then use Upload PDF instead.";
  }
});

// ---------- Incoming content from the Read Aloud Chrome extension ----------
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "read-aloud-extension") return;

  if (data.type === "incoming-pdf") {
    const file = new File([data.buffer], data.name || "Untitled.pdf", { type: "application/pdf" });
    ingestFile(file);
  } else if (data.type === "incoming-page-text") {
    ingestPlainText(data.title, data.text);
  }
});

// ---------- Library rendering ----------
function renderLibrary() {
  const grid = els["doc-grid"];
  grid.innerHTML = "";
  const sorted = [...state.docs].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);

  els["empty-state"].classList.toggle("hidden", sorted.length > 0);

  sorted.forEach(doc => {
    const card = document.createElement("div");
    card.className = "doc-card";
    const pct = doc.sentences.length ? Math.round((doc.position / doc.sentences.length) * 100) : 0;
    card.innerHTML = `
      <button class="delete-btn" title="Delete">✕</button>
      <h3></h3>
      <div class="meta">${doc.totalPages} page${doc.totalPages === 1 ? "" : "s"} · ${pct}% read</div>
      <div class="card-progress-bar"><div class="card-progress-fill" style="width:${pct}%"></div></div>
    `;
    card.querySelector("h3").textContent = doc.title;
    card.addEventListener("click", () => openReader(doc.id));
    card.querySelector(".delete-btn").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (confirm(`Delete "${doc.title}"?`)) {
        await dbDelete(doc.id);
        state.docs = state.docs.filter(d => d.id !== doc.id);
        renderLibrary();
      }
    });
    grid.appendChild(card);
  });
}

// ---------- Reader ----------
function openReader(id) {
  const doc = state.docs.find(d => d.id === id);
  if (!doc) return;
  stopSpeech();
  state.currentDoc = doc;
  state.idx = doc.position || 0;
  doc.lastOpenedAt = Date.now();
  dbPut(doc);

  els["reader-title"].textContent = doc.title;
  renderReadingPane(doc);
  updateProgressUI();
  scrollToSentence(state.idx, false);

  els["library-view"].classList.add("hidden");
  els["reader-view"].classList.remove("hidden");
}

function closeReader() {
  stopSpeech();
  if (state.currentDoc) {
    state.currentDoc.position = state.idx;
    dbPut(state.currentDoc);
  }
  renderLibrary();
  els["reader-view"].classList.add("hidden");
  els["library-view"].classList.remove("hidden");
}

els["back-btn"].addEventListener("click", closeReader);

function renderReadingPane(doc) {
  const pane = els["reading-pane"];
  pane.innerHTML = "";
  let lastPage = null;
  doc.sentences.forEach((s, i) => {
    if (s.page !== lastPage) {
      const marker = document.createElement("span");
      marker.className = "page-marker";
      marker.textContent = `Page ${s.page}`;
      pane.appendChild(marker);
      lastPage = s.page;
    }
    const span = document.createElement("span");
    span.className = `sentence type-${s.type || "body"}`;
    span.id = `sent-${i}`;
    span.textContent = s.text + " ";
    span.addEventListener("click", () => jumpToSentence(i));
    pane.appendChild(span);
  });
}

function updateSkipVisualState() {
  els["reading-pane"].classList.toggle("skip-extras-active", els["skip-extras"].checked);
}

function highlightSentence(i) {
  const prev = els["reading-pane"].querySelector(".sentence.active");
  if (prev) prev.classList.remove("active");
  const el = document.getElementById(`sent-${i}`);
  if (el) el.classList.add("active");
}

function scrollToSentence(i, smooth = true) {
  const el = document.getElementById(`sent-${i}`);
  if (el) el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
}

function updateProgressUI() {
  const doc = state.currentDoc;
  if (!doc) return;
  const total = doc.sentences.length;
  els["progress-text"].textContent = `Sentence ${Math.min(state.idx + 1, total)} / ${total} · Page ${doc.sentences[Math.min(state.idx, total - 1)]?.page ?? "-"}`;
  const pct = total ? (state.idx / total) * 100 : 0;
  els["reader-progress-fill"].style.width = pct + "%";
}

function jumpToSentence(i) {
  state.idx = i;
  highlightSentence(i);
  updateProgressUI();
  if (state.isPlaying) {
    speakFrom(i);
  }
  persistPosition();
}

function persistPosition() {
  if (!state.currentDoc) return;
  state.currentDoc.position = state.idx;
  dbPut(state.currentDoc);
}

// ---------- Speech ----------
function currentVoice() {
  const id = els["voice-select"].value;
  return state.voices.find(v => v.voiceURI === id) || null;
}

function speakFrom(i) {
  speechSynthesis.cancel();
  const doc = state.currentDoc;
  if (!doc || i >= doc.sentences.length) {
    state.isPlaying = false;
    setPlayButton(false);
    return;
  }
  state.idx = i;
  state.isPlaying = true;
  setPlayButton(true);
  speakSentence(i);
}

function speakSentence(i) {
  const doc = state.currentDoc;
  if (!doc) return;
  if (i >= doc.sentences.length) {
    state.isPlaying = false;
    setPlayButton(false);
    return;
  }

  const sentence = doc.sentences[i];
  const skipExtras = els["skip-extras"].checked;
  const skipTypes = skipExtras && (sentence.type === "title" || sentence.type === "author" || sentence.type === "boilerplate");

  let spoken = "";
  if (!skipTypes) {
    const raw = sentence.text;
    spoken = els["skip-parens"].checked ? stripCitationsAndAsides(raw) : raw;
    if (sentence.type === "heading" && spoken) spoken = `Heading: ${spoken}`;
  }

  if (!spoken) {
    // Nothing left to say (skipped type, or a sentence that was entirely parenthetical) — move on.
    state.idx = i;
    highlightSentence(i);
    scrollToSentence(i);
    updateProgressUI();
    persistPosition();
    speakSentence(i + 1);
    return;
  }

  const utter = new SpeechSynthesisUtterance(spoken);
  utter.rate = parseFloat(els["rate-slider"].value);
  utter.pitch = parseFloat(els["pitch-slider"].value);
  const voice = currentVoice();
  if (voice) utter.voice = voice;

  utter.onstart = () => {
    state.idx = i;
    highlightSentence(i);
    scrollToSentence(i);
    updateProgressUI();
    persistPosition();
  };

  utter.onend = () => {
    if (state.isPlaying) speakSentence(i + 1);
  };

  utter.onerror = (e) => {
    if (e.error !== "interrupted" && e.error !== "canceled") {
      console.error("Speech error:", e.error);
    }
  };

  speechSynthesis.speak(utter);
}

function stopSpeech() {
  speechSynthesis.cancel();
  state.isPlaying = false;
  setPlayButton(false);
}

function setPlayButton(playing) {
  els["play-btn"].textContent = playing ? "⏸ Pause" : "▶ Play";
}

els["play-btn"].addEventListener("click", () => {
  if (!state.currentDoc || !state.currentDoc.sentences.length) return;

  if (state.isPlaying) {
    speechSynthesis.pause();
    state.isPlaying = false;
    setPlayButton(false);
  } else if (speechSynthesis.paused) {
    speechSynthesis.resume();
    state.isPlaying = true;
    setPlayButton(true);
  } else {
    speakFrom(state.idx);
  }
});

els["stop-btn"].addEventListener("click", () => {
  stopSpeech();
});

els["prev-btn"].addEventListener("click", () => {
  const wasPlaying = state.isPlaying;
  const newIdx = Math.max(0, state.idx - 1);
  state.idx = newIdx;
  highlightSentence(newIdx);
  scrollToSentence(newIdx);
  updateProgressUI();
  persistPosition();
  if (wasPlaying) speakFrom(newIdx);
});

els["next-btn"].addEventListener("click", () => {
  const wasPlaying = state.isPlaying;
  const doc = state.currentDoc;
  if (!doc) return;
  const newIdx = Math.min(doc.sentences.length - 1, state.idx + 1);
  state.idx = newIdx;
  highlightSentence(newIdx);
  scrollToSentence(newIdx);
  updateProgressUI();
  persistPosition();
  if (wasPlaying) speakFrom(newIdx);
});

// Rate / pitch / voice changes: restart current sentence with new settings
els["rate-slider"].addEventListener("input", () => {
  els["rate-value"].textContent = parseFloat(els["rate-slider"].value).toFixed(1) + "×";
  localStorage.setItem("ra-rate", els["rate-slider"].value);
  if (state.isPlaying) speakFrom(state.idx);
});

els["pitch-slider"].addEventListener("input", () => {
  els["pitch-value"].textContent = parseFloat(els["pitch-slider"].value).toFixed(1);
  localStorage.setItem("ra-pitch", els["pitch-slider"].value);
  if (state.isPlaying) speakFrom(state.idx);
});

els["voice-select"].addEventListener("change", () => {
  localStorage.setItem("ra-voice", els["voice-select"].value);
  if (state.isPlaying) speakFrom(state.idx);
});

els["skip-parens"].addEventListener("change", () => {
  localStorage.setItem("ra-skip-parens", els["skip-parens"].checked ? "1" : "0");
  if (state.isPlaying) speakFrom(state.idx);
});

els["skip-extras"].addEventListener("change", () => {
  localStorage.setItem("ra-skip-extras", els["skip-extras"].checked ? "1" : "0");
  updateSkipVisualState();
  if (state.isPlaying) speakFrom(state.idx);
});

// Scores voices so natural-sounding ones (Enhanced/Premium/Neural/network voices)
// are suggested first, and novelty/legacy compact voices (Zarvox, Bells, etc.)
// sort last. The Web Speech API can't add new voices — better ones usually have
// to be installed at the OS level — but we can default to the best one available.
const HIGH_QUALITY_HINTS = /enhanced|premium|neural|natural|hd|wavenet/i;
const NOVELTY_VOICE_NAMES = new Set([
  "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Fred",
  "Good News", "Jester", "Junior", "Kathy", "Organ", "Ralph", "Superstar",
  "Trinoids", "Whisper", "Wobble", "Zarvox",
]);

function voiceScore(v) {
  let score = 0;
  if (HIGH_QUALITY_HINTS.test(v.name)) score += 100;
  if (/google/i.test(v.name)) score += 40;
  if (NOVELTY_VOICE_NAMES.has(v.name.split(" (")[0].trim())) score -= 100;
  if (v.localService === false) score += 10;
  if (v.default) score += 5;
  return score;
}

function populateVoices() {
  state.voices = speechSynthesis.getVoices();
  const select = els["voice-select"];
  const savedVoice = localStorage.getItem("ra-voice");
  select.innerHTML = "";

  const englishVoices = state.voices.filter(v => v.lang.startsWith("en"));
  const pool = englishVoices.length ? englishVoices : state.voices;
  const scored = pool
    .map(v => ({ v, score: voiceScore(v) }))
    .sort((a, b) => b.score - a.score || a.v.name.localeCompare(b.v.name));

  const recommended = scored.filter(s => s.score >= 0);
  const other = scored.filter(s => s.score < 0);

  function addGroup(label, list) {
    if (!list.length) return;
    const group = document.createElement("optgroup");
    group.label = label;
    list.forEach(({ v }) => {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      group.appendChild(opt);
    });
    select.appendChild(group);
  }

  addGroup("Recommended", recommended);
  addGroup("Other voices", other);

  if (savedVoice && [...select.options].some(o => o.value === savedVoice)) {
    select.value = savedVoice;
  } else if (recommended.length) {
    select.value = recommended[0].v.voiceURI;
    localStorage.setItem("ra-voice", select.value);
  }
}

speechSynthesis.onvoiceschanged = populateVoices;

// ---------- Keyboard shortcuts ----------
document.addEventListener("keydown", (e) => {
  if (els["reader-view"].classList.contains("hidden")) return;
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;

  if (e.code === "Space") {
    e.preventDefault();
    els["play-btn"].click();
  } else if (e.code === "ArrowRight") {
    els["next-btn"].click();
  } else if (e.code === "ArrowLeft") {
    els["prev-btn"].click();
  }
});

// Save position when leaving the page
window.addEventListener("beforeunload", () => {
  if (state.currentDoc) {
    state.currentDoc.position = state.idx;
    // best-effort synchronous-ish save; IndexedDB is async but this still fires the write
    dbPut(state.currentDoc);
  }
});

// ---------- Init ----------
async function init() {
  initTheme();
  initFontSize();

  const savedRate = localStorage.getItem("ra-rate");
  if (savedRate) {
    els["rate-slider"].value = savedRate;
    els["rate-value"].textContent = parseFloat(savedRate).toFixed(1) + "×";
  }
  const savedPitch = localStorage.getItem("ra-pitch");
  if (savedPitch) {
    els["pitch-slider"].value = savedPitch;
    els["pitch-value"].textContent = parseFloat(savedPitch).toFixed(1);
  }
  els["skip-parens"].checked = localStorage.getItem("ra-skip-parens") === "1";
  const savedSkipExtras = localStorage.getItem("ra-skip-extras");
  els["skip-extras"].checked = savedSkipExtras === null ? true : savedSkipExtras === "1";
  updateSkipVisualState();

  populateVoices();

  db = await openDB();
  state.docs = await dbGetAll();
  renderLibrary();
}

init();
