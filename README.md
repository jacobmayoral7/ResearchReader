# Read Aloud — Research Reader

A tiny personal website for reading PDFs (papers, book chapters, class readings) out loud.

- Upload a PDF — it's parsed entirely in your browser (nothing is sent to a server).
- Text is read aloud using your browser/OS's built-in text-to-speech voices.
- Adjustable speed, pitch, and voice.
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
  Edge, and Safari all ship different voice sets).
- Scanned/image-only PDFs (no selectable text) can't be read aloud — only PDFs with
  real text content work.
- Your saved library lives in each browser's local storage, so it won't sync between
  different browsers or devices automatically.
