// Builds the "Share" file: one standalone .html page containing the current
// data plus ScheduleGraph's own source, so it works without a server.
//
// ScheduleGraph.jsx is imported as raw text (`?raw`) and embedded as-is, so it
// must not have any static import other than the single `react` import line.
// Anything else has to be loaded with a dynamic import() inside a function.
import scheduleGraphRaw from "../components/ScheduleGraph.jsx?raw";
import cssRaw from "../index.css?raw";

const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205";

// Turns the component file into plain script text: React comes from a CDN
// global instead of an import, and `export default` is dropped. Bare dynamic
// imports cannot resolve on a standalone page, so pdf-lib is taken from its CDN
// global (window.PDFLib) and pdf.js is imported from a CDN URL. That import is
// wrapped in new Function() so the in-browser Babel step leaves it untouched
// (it would otherwise turn import() into require(), which does not exist).
function prepareComponentSource(raw) {
  return (
    raw
      .replace(
        /^import\s*\{[^}]*\}\s*from\s*["']react["'];?\s*$/m,
        "const { useState, useMemo, useRef, useEffect, useCallback } = React;"
      )
      .replace(/^export default function/m, "function")
      .replace(/import\(\s*["']pdf-lib["']\s*\)/, "Promise.resolve(window.PDFLib)")
      .replace(/import\(\s*["']pdfjs-dist\/([^"']*)["']\s*\)/g, (_, file) =>
        `new Function("return import('${PDFJS_CDN}/${file.replace(/\.mjs$/, ".min.mjs")}')")()`
      )
  );
}

// @tailwind directives mean nothing in a plain <style> tag, so they are removed.
function prepareCss(raw) {
  return raw.replace(/^@tailwind.*$/gm, "");
}

// The data is embedded as JSON; "<" is escaped so a value can never close
// the surrounding <script> tag.
export function buildSharePageHtml({ routeData, schedules, proposedSchedules }) {
  const componentSource = prepareComponentSource(scheduleGraphRaw);
  const css = prepareCss(cssRaw);
  const dataJson = JSON.stringify({ routeData, schedules, proposedSchedules }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CRIS Schedule &ndash; Shared View</title>
<style>
${css}
.share-banner {
  background: #fff7e6;
  border-bottom: 1px solid #f4c430;
  color: #7a5c00;
  padding: 8px 20px;
  font-size: 0.85rem;
  text-align: center;
}
.share-loading { padding: 40px; text-align: center; color: #5f6b76; font-family: Arial, Helvetica, sans-serif; }
</style>
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
<div id="root"><div class="share-loading">Loading shared schedule&hellip;</div></div>
<script type="text/babel" data-plugins="transform-react-jsx">
"use strict";
const SHARE_DATA = ${dataJson};

/** @jsxRuntime classic */
${componentSource}

function SharedApp() {
  return (
    <div className="cris-root">
      <div className="app-shell">
        <div className="tricolor-strip" />
        <div className="share-banner">
           read-only page.
        </div>
        <header className="app-header">
          <div className="emblem" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="40" height="40">
              <circle cx="24" cy="24" r="21" fill="none" stroke="#f4c430" strokeWidth="2" />
              <circle cx="24" cy="24" r="3" fill="#f4c430" />
              {Array.from({ length: 16 }).map((_, i) => {
                const angle = (i * 360) / 16;
                const rad = (angle * Math.PI) / 180;
                const x2 = 24 + 18 * Math.cos(rad);
                const y2 = 24 + 18 * Math.sin(rad);
                return <line key={i} x1="24" y1="24" x2={x2} y2={y2} stroke="#f4c430" strokeWidth="1" />;
              })}
            </svg>
          </div>
          <div className="header-text">
            <h1 className="app-title">CRIS</h1>
            <p className="app-subtitle">Centre for Railway Information Systems &mdash; Train Schedule &amp; Route Planner (shared view)</p>
          </div>
        </header>
        <ScheduleGraph
          routeData={SHARE_DATA.routeData}
          schedules={SHARE_DATA.schedules}
          proposedSchedules={SHARE_DATA.proposedSchedules}
        />
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<SharedApp />);
</script>
</body>
</html>
`;
}

