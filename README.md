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
