# Read Aloud — Research Reader

A tiny personal website for reading PDFs (papers, book chapters, class readings) out loud.

- Upload a PDF — it's parsed entirely in your browser (nothing is sent to a server).
- Text is read aloud using your browser/OS's built-in text-to-speech voices.
- Adjustable speed, pitch, and voice — voices are auto-sorted so natural-sounding
  ones (Enhanced/Premium/Neural/network voices) are suggested first.
- Detects headings (Abstract, Introduction, Methods, ...) from the PDF's font sizes
  and announces them ("Heading: Methods") when read aloud.
- Optional toggle to skip the title/author block and boilerplate (running headers/
  footers, copyright lines, DOIs, journal/volume info) — on by default.
- Optional toggle to skip citations and parenthetical asides (e.g. "(Smith et al.,
  2020)", "[12]", or inline stats like "(r = .45, p < .001)") when read aloud.
- Click any sentence to jump there; current sentence is highlighted and auto-scrolled.
- Your documents and reading position are saved in the browser (IndexedDB), so you can
  close the tab and pick up where you left off.
- Light/dark theme and adjustable text size.
- Besides the file picker, you can paste a direct link to a PDF and it'll fetch and
  parse it (works in any browser, including Safari) — subject to the source site
  allowing cross-site downloads (CORS).

## Running it locally

No build step needed — it's plain HTML/CSS/JS. Just serve the folder, e.g.:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 in your browser. (Opening `index.html` directly via
`file://` also mostly works, but some browsers restrict IndexedDB/worker loading over
`file://`, so a local server is more reliable.)

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", set **Source** to "Deploy from a branch", pick your
   default branch and the `/ (root)` folder, then save.
4. GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`.

## Installing it on your phone

This is a Progressive Web App (PWA), so it can be installed as a home-screen app
without an App Store:

- **iPhone/iPad (Safari)**: open the site, tap the Share icon, then **Add to Home
  Screen**.
- **Android (Chrome)**: open the site, tap the ⋮ menu, then **Install app** (or
  **Add to Home screen**).

Once installed, it opens full-screen like a regular app and works offline — your
uploaded PDFs, reading position, and settings are all stored on-device, and the app
shell (plus the PDF-parsing library) is cached so you can even upload a new PDF
without a connection.

## Chrome extension

`chrome-extension/` is a small Manifest V3 extension that adds a toolbar popup with:

- **Read selected text**, **Read this page aloud**, and **Pick paragraphs to
  read** all read *right there on the page* — a small floating player
  (play/pause, stop, speed) is injected directly into the tab you're on, so you
  can keep following along on the actual page instead of being sent anywhere
  else. "Read selected text" only appears (in the popup, and as a right-click
  option) when you've actually selected some text; otherwise it stays out of
  the way.
- **Pick paragraphs to read** turns on a picking mode: hover highlights
  clickable paragraphs, clicking one adds it to a numbered reading queue (click
  again to remove it), and the queue reads back in the order you clicked —
  paragraphs don't have to be in the page's original order. Hit the floating
  **Play** button once you've picked what you want.
- Whole-page extraction uses a lightweight reader-mode heuristic
  (`<article>`/`<main>`, with nav/header/footer/sidebar/TOC clutter stripped,
  falling back to the largest text block on the page) — it works well on most
  articles but isn't a full Readability parser, so it can occasionally pick up
  a stray banner or miss on unusual layouts. The paragraph picker uses the same
  clutter filtering to keep menu/TOC items out of its candidate list.
- **Send PDF to app** — fetches the current tab's PDF and sends it into the main
  Read Aloud app (so it gets the full treatment: heading detection, library,
  resume position). You can also right-click a PDF link (or right-click on an
  open PDF) for the same option in the context menu.

To install it (unpacked extensions can't be published without a Chrome Web Store
listing, so this is a one-time manual step):

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `chrome-extension` folder.

After pulling any update to this repo that touches the `chrome-extension/` folder,
click the reload icon on the extension's card in `chrome://extensions` to pick up
the change.

There's no Safari equivalent here — Apple requires all Safari extensions, even for
purely personal/local use, to be built and signed through Xcode with an Apple ID
(and re-signed every 7 days without a paid Apple Developer account). The
"paste a link" field in the app and drag-and-drop file upload cover the same need
in Safari without that overhead.

## Installing it on your computer

Since this is a PWA, desktop Chrome/Edge and Safari (macOS Sonoma/Safari 17+) can
install it as a real desktop app too, not just on phones:

- **Chrome/Edge**: open the site, click the install icon in the address bar (or
  menu → **Install Read Aloud…**).
- **Safari (macOS)**: open the site, then **File → Add to Dock**.

## Notes / limits

- Text-to-speech quality and available voices depend on your browser and OS (Chrome,
  Edge, and Safari all ship different voice sets). For less robotic speech on a Mac,
  install an Enhanced/Premium voice via System Settings → Accessibility → Spoken
  Content → System Voice → Manage Voices, then reload this page and pick it from the
  Voice dropdown.
- Heading detection and the title/author/boilerplate filters are heuristics based on
  font size and common patterns — they work well on typical journal-article PDFs but
  can occasionally misclassify an unusual layout. Turn the toggles off if a document
  seems to be losing content it shouldn't.
- Scanned/image-only PDFs (no selectable text) can't be read aloud — only PDFs with
  real text content work.
- Your saved library lives in each browser's local storage, so it won't sync between
  different browsers or devices automatically.
