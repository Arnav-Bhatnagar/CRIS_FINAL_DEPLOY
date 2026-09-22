# CRIS Train Schedule Planner

A browser-only tool that plots train schedules on a time/distance graph
(stations on the vertical axis, time on the horizontal axis, one line per
train). There is no backend: uploaded files are parsed in the browser.

## Run

```bash
npm install
npm run dev       # development server
npm run build     # production build in dist/
npm run lint
```

## Using the app

Upload up to three CSV/XLSX files (each upload card has a **Format** button
showing the expected layout):

1. **Original schedule** - drawn as solid lines.
2. **Proposed schedule** - optional, drawn as dashed lines on top.
3. **Route data** - station list with distances.

Column headers are matched by alias, so `Station` / `StationCode`,
`Entry_Time` / `ArrivalTime`, `Cumulative_Distance` / `Distance`, etc. all work.
Title rows above the header and multi-sheet workbooks are handled
automatically. Sample files are in `sheets/`.

Features: whole-week, single-day and 8-hour-shift views, per-train filter,
click a line to highlight it, right-click a line for a journey summary,
fullscreen, PDF export (with preview) and a **Share** button that saves a
standalone read-only `.html` copy of the current graph.

## Structure

```
src/
  App.jsx                      uploads, column aliases, page layout
  main.jsx                     entry point and preloader fade-out
  components/
    FileUploadCard.jsx         upload widget and "expected layout" modal
    ScheduleGraph.jsx          graph, PDF export and PDF preview
  utils/
    spreadsheet.js             CSV/XLSX reading and header/column matching
    exportSharePage.js         builds the standalone Share page
  index.css                    all styling
public/download.jpeg           CRIS logo (preloader and favicon)
sheets/                        sample input files
```

## Notes

- `ScheduleGraph.jsx` is embedded as raw text in the Share page, so it must
  keep a single static `import` (from `react`). Other libraries (`pdf-lib`,
  `pdfjs-dist`) are loaded with dynamic `import()` inside functions.
- The Share page loads React, `pdf-lib` and `pdfjs-dist` from CDNs (see `src/utils/exportSharePage.js`), so it needs an internet connection to open.
- The PDF preview is drawn with `pdfjs-dist` instead of an `<iframe>`, which
  some browsers block for `blob:` PDFs.
