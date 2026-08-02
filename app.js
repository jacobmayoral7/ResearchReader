// ---------- Setup ----------
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

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
  "font-inc", "font-dec", "skip-parens",
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
function splitSentences(text) {
  const matches = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g);
  return matches ? matches.map(s => s.trim()).filter(Boolean) : [];
}

// Removes parenthetical asides (e.g. inline stats like "(r = .05, d = .2)")
// from text before it's spoken. Display text is left untouched.
function stripParensForSpeech(text) {
  return text
    .replace(/\([^()]*\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------- PDF extraction ----------
async function extractPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const sentences = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(" ").replace(/\s+/g, " ").trim();
    const pageSentences = splitSentences(pageText);
    pageSentences.forEach((s, i) => {
      sentences.push({ text: s, page: pageNum, firstOnPage: i === 0 });
    });

    const pct = Math.round((pageNum / pdf.numPages) * 100);
    els["upload-progress-fill"].style.width = pct + "%";
  }

  return { sentences, totalPages: pdf.numPages };
}

// ---------- Upload flow ----------
els["file-input"].addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";

  els["upload-progress"].classList.remove("hidden");
  els["upload-progress-fill"].style.width = "0%";

  try {
    const { sentences, totalPages } = await extractPdf(file);
    const doc = {
      id: crypto.randomUUID(),
      title: file.name.replace(/\.pdf$/i, ""),
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
  } catch (err) {
    console.error(err);
    alert("Couldn't read that PDF. It may be scanned/image-only (no selectable text) or corrupted.");
  } finally {
    els["upload-progress"].classList.add("hidden");
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
    span.className = "sentence";
    span.id = `sent-${i}`;
    span.textContent = s.text + " ";
    span.addEventListener("click", () => jumpToSentence(i));
    pane.appendChild(span);
  });
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

  const raw = doc.sentences[i].text;
  const spoken = els["skip-parens"].checked ? stripParensForSpeech(raw) : raw;

  if (!spoken) {
    // Nothing left to say (e.g. a sentence that was entirely parenthetical) — move on.
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

function populateVoices() {
  state.voices = speechSynthesis.getVoices();
  const select = els["voice-select"];
  const savedVoice = localStorage.getItem("ra-voice");
  select.innerHTML = "";
  state.voices
    .filter(v => v.lang.startsWith("en") || state.voices.every(vv => !vv.lang.startsWith("en")))
    .forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      select.appendChild(opt);
    });
  if (savedVoice && [...select.options].some(o => o.value === savedVoice)) {
    select.value = savedVoice;
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

  populateVoices();

  db = await openDB();
  state.docs = await dbGetAll();
  renderLibrary();
}

init();
