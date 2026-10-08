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
const DB_VERSION = 2;
const STORE = "documents";
const FOLDER_STORE = "folders";

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(FOLDER_STORE)) {
        database.createObjectStore(FOLDER_STORE, { keyPath: "id" });
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

function dbPutFolder(folder) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FOLDER_STORE, "readwrite");
    tx.objectStore(FOLDER_STORE).put(folder);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbGetAllFolders() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FOLDER_STORE, "readonly");
    const req = tx.objectStore(FOLDER_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDeleteFolder(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FOLDER_STORE, "readwrite");
    tx.objectStore(FOLDER_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- State ----------
const state = {
  docs: [],
  folders: [],
  currentFolderId: null, // null = viewing the top-level library
  chapterStarts: new Map(), // sentenceIndex -> chapter, for the open document
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
  "folders-bar", "folder-back-btn", "library-title",
  "chapter-bar", "chapter-select", "chapter-prev", "chapter-next", "chapter-only",
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
    // Whole-word and case-sensitive: otherwise "St." matches the end of "last."
    // and "p." the end of "step.", gluing separate sentences together.
    const re = new RegExp("\\b" + escaped, "g");
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
      current = { text: str, page: pageNum, fontSize, bold, y };
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

// Figure/table captions ("Figure 3. ...", "Table 2: ...", "Source: ...") and the
// stray text that lives inside charts and tables (axis labels, numbers). Body
// text that merely mentions a figure ("Figure 3 shows ...") has no punctuation
// right after the number, so it doesn't match.
const CAPTION_START_RE =
  /^(?:(?:figure|fig\.?|table|exhibit|plate|photo|photograph|image|illustration|chart|graph|map|diagram|box)\s*\d+[A-Za-z]?\s*(?:[.:\-\u2013\u2014|]|$)|(?:source|sources|note|notes|credit|photo credit|image credit)\s*:)/i;
const NUMERIC_FRAGMENT_RE = /^[\d\s.,%\-\u2013\u2212+()\/:]+$/;

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
  let lastLine = null;
  let captionLines = 0; // >0 while we're inside a multi-line caption
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

    // "Chapter 1", "Chapter 2", ... become the same string once digits are
    // masked, so they'd look like a running header repeated on every page —
    // but a large "Chapter N" line is a real chapter start, not page furniture.
    const isBigChapterHeading = CHAPTER_TITLE_RE.test(line.text) && line.fontSize / (bodySize || 1) >= 1.15;
    if (!isBigChapterHeading && isBoilerplateLine(line.text, repeatCount, totalPages)) {
      flushBody();
      sentences.push({ text: line.text, page: line.page, type: "boilerplate" });
      return;
    }

    const heading = isHeadingLine(line, bodySize);

    // Captions and chart/table text. A caption continues onto following lines
    // while they stay tightly spaced (no paragraph gap), at body size or
    // smaller, on the same page and column (gap > 0 means still moving down).
    const prevLine = lastLine && lastLine.page === line.page ? lastLine : null;
    lastLine = line;
    const sizeRatio = line.fontSize / (bodySize || 1);
    const gap = prevLine ? prevLine.y - line.y : -1;
    const isCaptionStart = CAPTION_START_RE.test(line.text);
    const continuesCaption =
      captionLines > 0 && captionLines < 6 && !heading && gap > 0 &&
      gap <= line.fontSize * 1.45 && sizeRatio <= 1.02;
    const isFigureFragment =
      !heading && (sizeRatio < 0.88 || (NUMERIC_FRAGMENT_RE.test(line.text) && line.text.length <= 24));

    if (isCaptionStart || continuesCaption || isFigureFragment) {
      flushBody();
      captionLines = isFigureFragment && !isCaptionStart && !continuesCaption ? 0 : captionLines + 1;
      sentences.push({ text: line.text, page: line.page, type: "caption" });
      return;
    }
    captionLines = 0;

    if (line.page === 1 && phase === "before-title" && heading && CHAPTER_TITLE_RE.test(line.text)) {
      flushBody();
      sentences.push({ text: line.text, page: line.page, type: "heading" });
      phase = "done";
      return;
    }

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
  const outline = await getPdfOutline(pdf);
  const chapters = buildChapters(sentences, outline);

  return { sentences, totalPages: pdf.numPages, chapters };
}

// ---------- Chapters ----------
const NUMBER_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty";
const CHAPTER_TITLE_RE = new RegExp(`^(?:chapter|unit|part|module|lesson)\\s+(?:\\d+|[ivxlcdm]+|${NUMBER_WORDS})\\b`, "i");

// A PDF's own bookmarks (its table of contents) are the most reliable chapter
// list when the file has them — books and course readings usually do.
async function getPdfOutline(pdf) {
  try {
    const outline = await pdf.getOutline();
    if (!outline || !outline.length) return [];

    async function pageOf(item) {
      let dest = item.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) return null;
      const ref = dest[0];
      if (typeof ref === "number") return ref + 1;
      return (await pdf.getPageIndex(ref)) + 1;
    }

    // If there are only a couple of top-level entries (e.g. one book-title
    // entry with the real chapters nested inside), include one level down.
    const items = outline.length < 3 ? outline.flatMap(o => [o, ...(o.items || [])]) : outline;
    const result = [];
    for (const item of items) {
      const title = (item.title || "").replace(/\s+/g, " ").trim();
      const page = await pageOf(item).catch(() => null);
      if (title && page) result.push({ title, page });
    }
    return result;
  } catch (err) {
    console.warn("Couldn't read PDF outline:", err);
    return [];
  }
}

const normForMatch = t => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Maps a bookmark (title + page) to the sentence where that chapter begins.
function locateChapterStart(sentences, title, page) {
  const want = normForMatch(title);
  const onOrAfter = [];
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].page >= page && sentences[i].page <= page + 1) onOrAfter.push(i);
  }
  if (!onOrAfter.length) return -1;
  if (want.length >= 4) {
    const byHeading = onOrAfter.find(i => {
      const s = sentences[i];
      if (s.type !== "heading" && s.type !== "title") return false;
      const have = normForMatch(s.text);
      // Bookmark "Chapter 1: Foundations" vs heading lines "Chapter 1" / "Foundations":
      // match either direction so a title split over lines still finds its first line.
      return have.includes(want.slice(0, 40)) || (have.length >= 4 && want.includes(have));
    });
    if (byHeading !== undefined) return byHeading;
    const byText = onOrAfter.find(i => normForMatch(sentences[i].text).includes(want.slice(0, 40)));
    if (byText !== undefined) return byText;
  }
  const firstOnPage = onOrAfter.find(i => sentences[i].page === page && !["boilerplate", "caption"].includes(sentences[i].type));
  return firstOnPage !== undefined ? firstOnPage : -1;
}

// Fallback when the PDF has no usable bookmarks: "Chapter 3 ..."-style
// headings; failing that, every detected heading is offered as a "section".
function deriveChaptersFromHeadings(sentences) {
  const heads = [];
  sentences.forEach((s, i) => { if (s.type === "heading") heads.push(i); });

  const chapterIdxs = heads.filter(i => CHAPTER_TITLE_RE.test(sentences[i].text));
  if (chapterIdxs.length >= 2) {
    return chapterIdxs.map(i => {
      // "Chapter 3" and its title are often two separate heading lines — join them.
      const next = sentences[i + 1];
      const title = next && next.type === "heading" && !CHAPTER_TITLE_RE.test(next.text)
        ? `${sentences[i].text} — ${next.text}`
        : sentences[i].text;
      return { title, sentenceIndex: i, page: sentences[i].page, kind: "chapter" };
    });
  }
  if (heads.length >= 2) {
    return heads.map(i => ({ title: sentences[i].text, sentenceIndex: i, page: sentences[i].page, kind: "section" }));
  }
  return [];
}

function buildChapters(sentences, outline) {
  if (outline && outline.length >= 2) {
    const seen = new Set();
    const chapters = [];
    for (const o of outline) {
      const idx = locateChapterStart(sentences, o.title, o.page);
      if (idx < 0 || seen.has(idx)) continue;
      seen.add(idx);
      chapters.push({ title: o.title, sentenceIndex: idx, page: sentences[idx].page, kind: "chapter" });
    }
    chapters.sort((a, b) => a.sentenceIndex - b.sentenceIndex);
    if (chapters.length >= 2) return chapters;
  }
  return deriveChaptersFromHeadings(sentences);
}

// ---------- Upload flow ----------
// New documents land in whichever folder you're currently browsing (or
// ungrouped, at the top level), so uploading while inside a folder just works.
async function saveAndOpenDoc(title, sentences, totalPages, chapters) {
  const doc = {
    id: crypto.randomUUID(),
    title: title || "Untitled",
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
    sentences,
    totalPages,
    position: 0,
    chapters: chapters || [],
    folderId: state.currentFolderId,
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
    const { sentences, totalPages, chapters } = await extractPdf(file);
    await saveAndOpenDoc((titleHint || file.name).replace(/\.pdf$/i, ""), sentences, totalPages, chapters);
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
  ".navbox, .mw-editsection, script, style, noscript, template, svg, " +
  "figure, figcaption, picture, [class*='caption']";

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

// ---------- Folders ----------
async function createFolder(name) {
  const folder = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  await dbPutFolder(folder);
  state.folders.push(folder);
  return folder;
}

function openFolder(id) {
  state.currentFolderId = id;
  renderLibrary();
}

function closeFolder() {
  state.currentFolderId = null;
  renderLibrary();
}

els["folder-back-btn"].addEventListener("click", closeFolder);

// ---------- Library rendering ----------
function renderFoldersBar() {
  const bar = els["folders-bar"];
  bar.innerHTML = "";
  // Folders are only browsable one level deep, so the bar (and the option to
  // create a new one) only shows at the top level, not while inside a folder.
  if (state.currentFolderId !== null) return;

  state.folders
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(folder => {
      const count = state.docs.filter(d => d.folderId === folder.id).length;
      const card = document.createElement("div");
      card.className = "folder-card";
      card.innerHTML = `📁 <span class="folder-name"></span> <span class="folder-count">${count}</span> <button class="folder-delete-btn" title="Delete folder">✕</button>`;
      card.querySelector(".folder-name").textContent = folder.name;
      card.addEventListener("click", () => openFolder(folder.id));
      card.querySelector(".folder-delete-btn").addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (confirm(`Delete folder "${folder.name}"? Documents inside will stay, just ungrouped.`)) {
          await dbDeleteFolder(folder.id);
          state.folders = state.folders.filter(f => f.id !== folder.id);
          const affected = state.docs.filter(d => d.folderId === folder.id);
          for (const d of affected) {
            d.folderId = null;
            await dbPut(d);
          }
          renderLibrary();
        }
      });
      bar.appendChild(card);
    });

  const newCard = document.createElement("div");
  newCard.className = "folder-card new-folder-card";
  newCard.textContent = "+ New folder";
  newCard.addEventListener("click", async () => {
    const name = prompt("Folder name:");
    if (name && name.trim()) await createFolder(name.trim());
    renderLibrary();
  });
  bar.appendChild(newCard);
}

function buildFolderSelect(doc) {
  const select = document.createElement("select");
  select.className = "folder-select";
  select.title = "Move to folder";

  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "No folder";
  select.appendChild(noneOpt);

  state.folders
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(folder => {
      const opt = document.createElement("option");
      opt.value = folder.id;
      opt.textContent = folder.name;
      select.appendChild(opt);
    });

  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = "+ New folder…";
  select.appendChild(newOpt);

  select.value = doc.folderId || "";

  select.addEventListener("click", (ev) => ev.stopPropagation());
  select.addEventListener("change", async (ev) => {
    ev.stopPropagation();
    let targetId = select.value;
    if (targetId === "__new__") {
      const name = prompt("Folder name:");
      if (!name || !name.trim()) {
        select.value = doc.folderId || "";
        return;
      }
      const folder = await createFolder(name.trim());
      targetId = folder.id;
    }
    doc.folderId = targetId || null;
    await dbPut(doc);
    renderLibrary();
  });

  return select;
}

function renderLibrary() {
  const grid = els["doc-grid"];
  grid.innerHTML = "";

  const inFolder = state.currentFolderId !== null;
  els["folder-back-btn"].classList.toggle("hidden", !inFolder);
  if (inFolder) {
    const folder = state.folders.find(f => f.id === state.currentFolderId);
    els["library-title"].textContent = folder ? `📁 ${folder.name}` : "📚 Read Aloud";
    if (!folder) state.currentFolderId = null; // folder was deleted elsewhere; fall back
  } else {
    els["library-title"].textContent = "📚 Read Aloud";
  }

  renderFoldersBar();

  const visibleDocs = state.docs.filter(d => (d.folderId || null) === state.currentFolderId);
  const sorted = visibleDocs.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);

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
    card.appendChild(buildFolderSelect(doc));
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
  // Documents saved before chapter detection existed get chapters derived
  // from their headings on first open.
  if (!doc.chapters) doc.chapters = deriveChaptersFromHeadings(doc.sentences);
  dbPut(doc);

  els["reader-title"].textContent = doc.title;
  renderReadingPane(doc);
  populateChapters(doc);
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

// ---------- Chapter navigation ----------
function populateChapters(doc) {
  const chapters = doc.chapters || [];
  state.chapterStarts = new Map(chapters.map(c => [c.sentenceIndex, c]));
  const select = els["chapter-select"];
  select.innerHTML = "";
  chapters.forEach((c, n) => {
    const opt = document.createElement("option");
    opt.value = String(c.sentenceIndex);
    opt.textContent = c.title.length > 70 ? c.title.slice(0, 67) + "…" : c.title;
    opt.dataset.n = String(n);
    select.appendChild(opt);
  });
  const isChapters = chapters.some(c => c.kind === "chapter");
  select.title = isChapters ? "Jump to chapter" : "Jump to section";
  els["chapter-bar"].classList.toggle("hidden", chapters.length < 2);
}

// Index (into doc.chapters) of the chapter the reading position is currently in.
function currentChapterIndex() {
  const chapters = state.currentDoc?.chapters || [];
  let cur = -1;
  chapters.forEach((c, n) => { if (c.sentenceIndex <= state.idx) cur = n; });
  return cur;
}

function goToChapter(n) {
  const chapters = state.currentDoc?.chapters || [];
  if (n < 0 || n >= chapters.length) return;
  const target = chapters[n].sentenceIndex;
  state.idx = target;
  highlightSentence(target);
  scrollToSentence(target);
  updateProgressUI();
  persistPosition();
  if (state.isPlaying) speakFrom(target);
}

els["chapter-select"].addEventListener("change", () => {
  goToChapter(els["chapter-select"].selectedIndex);
});

els["chapter-next"].addEventListener("click", () => goToChapter(currentChapterIndex() + 1));

els["chapter-prev"].addEventListener("click", () => {
  const chapters = state.currentDoc?.chapters || [];
  const cur = currentChapterIndex();
  // Partway into a chapter, "previous" restarts it; at its very start, go back one.
  if (cur >= 0 && state.idx > chapters[cur].sentenceIndex) goToChapter(cur);
  else goToChapter(cur - 1);
});

els["chapter-only"].addEventListener("change", () => {
  localStorage.setItem("ra-chapter-only", els["chapter-only"].checked ? "1" : "0");
});

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

  const cur = currentChapterIndex();
  if (cur >= 0 && els["chapter-select"].selectedIndex !== cur) els["chapter-select"].selectedIndex = cur;
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

// `auto` is true when playback advanced by itself (not from a button or click),
// which is what lets "one chapter at a time" stop at a chapter boundary.
function speakSentence(i, auto = false) {
  const doc = state.currentDoc;
  if (!doc) return;
  if (i >= doc.sentences.length) {
    state.isPlaying = false;
    setPlayButton(false);
    return;
  }

  const chapter = state.chapterStarts.get(i);
  if (auto && chapter && els["chapter-only"].checked) {
    // Finished the chapter — park at the start of the next one, ready to resume.
    state.idx = i;
    highlightSentence(i);
    scrollToSentence(i);
    updateProgressUI();
    persistPosition();
    state.isPlaying = false;
    setPlayButton(false);
    return;
  }

  const sentence = doc.sentences[i];
  const skipExtras = els["skip-extras"].checked;
  const skipTypes = skipExtras && ["title", "author", "boilerplate", "caption"].includes(sentence.type);

  let spoken = "";
  if (!skipTypes) {
    const raw = sentence.text;
    spoken = els["skip-parens"].checked ? stripCitationsAndAsides(raw) : raw;
    if (sentence.type === "heading" && spoken) spoken = `Heading: ${spoken}`;
    // A chapter that begins mid-text (no heading line of its own) still gets announced.
    if (chapter && chapter.kind === "chapter" && sentence.type !== "heading" && spoken) {
      spoken = `Chapter: ${chapter.title}. ${spoken}`;
    }
  }

  if (!spoken) {
    // Nothing left to say (skipped type, or a sentence that was entirely parenthetical) — move on.
    state.idx = i;
    highlightSentence(i);
    scrollToSentence(i);
    updateProgressUI();
    persistPosition();
    speakSentence(i + 1, true);
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
    if (state.isPlaying) speakSentence(i + 1, true);
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
  els["chapter-only"].checked = localStorage.getItem("ra-chapter-only") === "1";
  const savedSkipExtras = localStorage.getItem("ra-skip-extras");
  els["skip-extras"].checked = savedSkipExtras === null ? true : savedSkipExtras === "1";
  updateSkipVisualState();

  populateVoices();

  db = await openDB();
  state.docs = await dbGetAll();
  state.folders = await dbGetAllFolders();
  renderLibrary();
}

init();
