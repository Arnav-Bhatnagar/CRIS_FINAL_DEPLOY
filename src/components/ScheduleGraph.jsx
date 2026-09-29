import { useMemo, useRef, useState, useEffect, useCallback } from "react";

// Train line colour is a fixed rule based on the train number, so a train keeps
// the same colour in every view:
//   - starts with 12, 20, 21, 22 or 26 -> deep pink
//   - otherwise by first digit: 1/2/8 red, 5/6/7 blue, 3/4/9 black, 0 purple
const COLOR_DEEP_PINK = "#ff1493";
const COLOR_RED = "#dc2626";
const COLOR_BLUE = "#1d4ed8";
const COLOR_BLACK = "#000000";
const COLOR_PURPLE = "#7c3aed";
const COLOR_FALLBACK = "#334155";

const PINK_PREFIXES = ["12", "20", "21", "22", "26"];
const FIRST_DIGIT_RED = new Set(["1", "2", "8"]);
const FIRST_DIGIT_BLUE = new Set(["5", "6", "7"]);
const FIRST_DIGIT_BLACK = new Set(["3", "4", "9"]);

function colorForTrainNo(trainNo) {
  const match = String(trainNo).match(/^\d+/);
  if (!match) return COLOR_FALLBACK;
  const digits = match[0]; 
   


  if (PINK_PREFIXES.some((prefix) => digits.startsWith(prefix))) return COLOR_DEEP_PINK;

  const firstDigit = digits[0];
  if (FIRST_DIGIT_RED.has(firstDigit)) return COLOR_RED;
  if (FIRST_DIGIT_BLUE.has(firstDigit)) return COLOR_BLUE;
  if (FIRST_DIGIT_BLACK.has(firstDigit)) return COLOR_BLACK;
  if (firstDigit === "0") return COLOR_PURPLE;
  return COLOR_FALLBACK;
}

function formatTrainNo(trainNo) {
  const match = String(trainNo).match(/^\d+/);
  if (!match) return String(trainNo);
  return match[0].slice(0, 5).padStart(5, "0");
}

// One background/header colour pair per day column (cycles every 7 days).
const BAND_COLORS = [
  { bg: "#eff6ff", header: "#2563eb" },
  { bg: "#ecfdf5", header: "#059669" },
  { bg: "#fffbeb", header: "#d97706" },
  { bg: "#f5f3ff", header: "#7c3aed" },
  { bg: "#fdf2f8", header: "#db2777" },
  { bg: "#fff7ed", header: "#ea580c" },
  { bg: "#ecfeff", header: "#0891b2" },
];

const hourLabel = (mins) => `${String(Math.floor(((mins % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:00`;
function formatClock(minsInDay) {
  const wrapped = ((minsInDay % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = Math.round(wrapped % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Layout constants, in SVG pixels. The graph viewport grows from VIEWPORT_H to fill the window.
const HEADER_H = 28;
const AXIS_H = 22;
const VIEWPORT_H = 300;
const PAGE_BOTTOM_GAP = 28;
const ROW_SPACING = 40;
const WEEK_W = 700;
const MINOR_TICK_MIN = 10;
const MAX_TRAINS_FOR_ALL_OPTION = 40;

// Shows the generated PDF page by page on <canvas> elements using pdf.js.
// The browser's own PDF viewer is not used because a blob: PDF inside an
// <iframe> can be blocked ("This page has been blocked by Chrome").
//
// pdf.js is loaded with a dynamic import() because this file is also embedded
// as raw text in the Share page (see utils/exportSharePage.js). If pdf.js
// fails to load, the original iframe is used as a fallback.
function PdfPagesPreview({ blob, url }) {
  const hostRef = useRef(null);
  const [state, setState] = useState("loading");

  useEffect(() => {
    let cancelled = false;
    let doc = null;
    const host = hostRef.current;

    (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
        ]);
        globalThis.pdfjsWorker = worker;

        const data = new Uint8Array(await blob.arrayBuffer());
        doc = await pdfjs.getDocument({ data }).promise;
        if (cancelled) return;

        const dpr = window.devicePixelRatio || 1;
        const cssWidth = Math.max(300, (host?.clientWidth || 900) - 24 - 18);
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = cssWidth / base.width;
          const viewport = page.getViewport({ scale: scale * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = cssWidth + "px";
          canvas.style.height = Math.floor(viewport.height / dpr) + "px";
          canvas.className = "pdf-preview-page";
          host?.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          if (n === 1) setState("ready");
        }
      } catch (err) {
        console.warn("PDF canvas preview failed, falling back to iframe:", err);
        if (!cancelled) setState("fallback");
      }
    })();

    return () => {
      cancelled = true;
      if (doc) doc.destroy();
      if (host) host.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
    };
  }, [blob]);

  if (state === "fallback") {
    return <iframe title="PDF preview" src={url} className="pdf-preview-frame" />;
  }
  return (
    <div className="pdf-preview-pages" ref={hostRef}>
      {state === "loading" && <div className="pdf-preview-loading">Rendering preview&hellip;</div>}
    </div>
  );
}

// Time/distance graph: stations on the vertical axis, time on the horizontal
// axis, one line per train. Views: whole week, single day, or 8-hour shift.
// Solid lines are the baseline schedule, dashed lines the proposed one.
export default function ScheduleGraph({ routeData, schedules, proposedSchedules = [] }) {
  const [view, setView] = useState("week");
  const [weekActivated, setWeekActivated] = useState(true);
  const [dayIndex, setDayIndex] = useState(null);
  const [shift, setShift] = useState(1);
  const [shiftChecked, setShiftChecked] = useState(false);
  const [selectedTrain, setSelectedTrain] = useState(null);
  const [showProposed, setShowProposed] = useState(true);
  const [pinnedTrain, setPinnedTrain] = useState(null);
  const [journeyPopup, setJourneyPopup] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfStatus, setPdfStatus] = useState(null);
  const [pdfPreview, setPdfPreview] = useState(null);

  const topRef = useRef(null);
  const timeTopRef = useRef(null);
  const bottomRef = useRef(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const mainRef = useRef(null);
  const trainPlotsCacheRef = useRef({ deps: null, value: [] });
  const proposedTrainPlotsCacheRef = useRef({ deps: null, value: [] });

  const graphWrapRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setIsFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);
  const toggleFullscreen = () => {
    const next = !isFullscreen;
    setIsFullscreen(next);
    try {
      if (next) {
        graphWrapRef.current?.requestFullscreen?.().catch(() => {});
      } else if (document.fullscreenElement) {
        document.exitFullscreen();
      }
    } catch {
      // Fullscreen API unavailable or blocked: the CSS fullscreen layout still applies.
    }
  };

  // Frozen header/sidebar layout: the scrolling panels are kept in sync.
  const syncHorizontal = useCallback((scrollLeft, source) => {
    [topRef, timeTopRef, bottomRef, mainRef].forEach((ref) => {
      if (ref.current && ref.current !== source) ref.current.scrollLeft = scrollLeft;
    });
  }, []);
  const syncVertical = useCallback((scrollTop, source) => {
    [leftRef, rightRef, mainRef].forEach((ref) => {
      if (ref.current && ref.current !== source) ref.current.scrollTop = scrollTop;
    });
  }, []);
  const onMainScroll = (e) => { syncHorizontal(e.target.scrollLeft, e.target); syncVertical(e.target.scrollTop, e.target); };
  const onTopScroll = (e) => syncHorizontal(e.target.scrollLeft, e.target);
  const onTimeTopScroll = (e) => syncHorizontal(e.target.scrollLeft, e.target);
  const onBottomScroll = (e) => syncHorizontal(e.target.scrollLeft, e.target);
  const onLeftScroll = (e) => syncVertical(e.target.scrollTop, e.target);
  const onRightScroll = (e) => syncVertical(e.target.scrollTop, e.target);

  const [containerWidth, setContainerWidth] = useState(0);
  const hasRouteData = routeData.length > 0;
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasRouteData]);

  const [midHeight, setMidHeight] = useState(VIEWPORT_H);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const fitToWindow = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const available = window.innerHeight - top - AXIS_H - PAGE_BOTTOM_GAP;
      setMidHeight(Math.max(VIEWPORT_H, Math.floor(Math.min(available, routeData.length * ROW_SPACING))));
    };
    fitToWindow();
    window.addEventListener("resize", fitToWindow);
    return () => window.removeEventListener("resize", fitToWindow);
  }, [hasRouteData, routeData.length, view, containerWidth, isFullscreen]);

  const journeyPopupRef = useRef(null);
  useEffect(() => {
    if (!journeyPopup) return;
    const onKeyDown = (e) => { if (e.key === "Escape") setJourneyPopup(null); };
    const onDocClick = (e) => {
      if (journeyPopupRef.current && !journeyPopupRef.current.contains(e.target)) setJourneyPopup(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onDocClick);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onDocClick);
    };
  }, [journeyPopup]);

  const rowIndexOf = useMemo(() => {
    const map = {};
    routeData.forEach((s, i) => (map[s.station] = i));
    return map;
  }, [routeData]);
  const distanceOf = useMemo(() => {
    const map = {};
    routeData.forEach((s) => (map[s.station] = s.cumulativeDistance));
    return map;
  }, [routeData]);

  const graphHeight = Math.max(VIEWPORT_H, routeData.length * ROW_SPACING);
  const yOf = (index) => index * ROW_SPACING + ROW_SPACING / 2;

  const usesDayColumn = schedules.some((s) => s.day);
  const dayLabels = useMemo(() => {
    if (!usesDayColumn) return null;
    return [...new Set(schedules.map((s) => s.day))];
  }, [schedules, usesDayColumn]);

  function dayIndexOfRow(row) {
    return usesDayColumn ? dayLabels.indexOf(row.day) : 0;
  }
  function toContinuousEntry(row) {
    if (usesDayColumn) return dayIndexOfRow(row) * 1440 + row.entryMinutesInDay;
    return row.entryMinutesInDay;
  }
  function toContinuousExit(row) {
    if (usesDayColumn) return dayIndexOfRow(row) * 1440 + row.exitMinutesInDay;
    return row.exitMinutesInDay;
  }
  function labelForDay(idx) {
    const weekday = WEEKDAY_NAMES[((idx % 7) + 7) % 7];
    return String(usesDayColumn ? dayLabels[idx] ?? weekday : weekday).slice(0, 3);
  }

  const trainList = useMemo(
    () => [...new Set([...schedules, ...proposedSchedules].map((s) => s.trainNo))],
    [schedules, proposedSchedules]
  );
  useEffect(() => {
    if (selectedTrain === null && trainList.length > 0) {
      setSelectedTrain(trainList.length > MAX_TRAINS_FOR_ALL_OPTION ? trainList[0] : "ALL");
    }
  }, [trainList, selectedTrain]);
  const visibleSchedules =
    selectedTrain === "ALL" ? schedules : schedules.filter((s) => s.trainNo === selectedTrain);
  const visibleProposedSchedules =
    selectedTrain === "ALL" ? proposedSchedules : proposedSchedules.filter((s) => s.trainNo === selectedTrain);

  const colorOf = colorForTrainNo;

  const isHighlighted = (trainNo) =>
    pinnedTrain ? pinnedTrain === trainNo : selectedTrain !== "ALL" && selectedTrain === trainNo;
  const dimOthers = pinnedTrain !== null;

  useEffect(() => {
    const onDocClick = () => setPinnedTrain(null);
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  if (routeData.length === 0) {
    return <p className="graph-empty">Upload a route-data file to see the station panels.</p>;
  }

  // Time window for the current view, in minutes from the start of the week.
  let start, end, width, tickStep, zoomed;
  if (view === "week") {
    start = 0;
    end = 7 * 1440;
    width = Math.max(WEEK_W, containerWidth);
    tickStep = 720;
    zoomed = false;
  } else if (view === "day") {
    start = dayIndex * 1440;
    end = (dayIndex + 1) * 1440;
    width = Math.max(1200, containerWidth);
    tickStep = 60;
    zoomed = true;
  } else {
    start = dayIndex * 1440 + (shift - 1) * 480;
    end = dayIndex * 1440 + shift * 480;
    width = Math.max(700, containerWidth);
    tickStep = 60;
    zoomed = true;
  }
  const xOf = (mins) => ((mins - start) / (end - start)) * width;
  const clampX = (x) => Math.max(0, Math.min(width, x));

  const firstDayIdx = Math.floor(start / 1440);
  const lastDayIdx = Math.floor((end - 1) / 1440);
  const daySegments = [];
  for (let d = firstDayIdx; d <= lastDayIdx; d++) {
    daySegments.push({ idx: d, from: Math.max(start, d * 1440), to: Math.min(end, (d + 1) * 1440) });
  }

  function renderTimeAxisSvg() {
    return (
      <>
        {daySegments.map((seg) => (
          <rect key={seg.idx} x={xOf(seg.from)} y={0} width={xOf(seg.to) - xOf(seg.from)} height={AXIS_H} fill={BAND_COLORS[seg.idx % BAND_COLORS.length].bg} />
        ))}

        {zoomed && (() => {
          const minors = [];
          for (let m = start; m <= end; m += MINOR_TICK_MIN) {
            if (m % tickStep !== 0) minors.push(m);
          }
          return minors.map((m) => (
            <line key={`axm-${m}`} x1={xOf(m)} x2={xOf(m)} y1={AXIS_H * 0.6} y2={AXIS_H} stroke="#94a3b8" strokeWidth="0.75" />
          ));
        })()}

        {(() => {
          const ticks = [];
          for (let m = start; m <= end; m += tickStep) ticks.push(m);
          return ticks.map((m) => {
            const x = xOf(m);
            const atLeftEdge = x <= 2;
            const atRightEdge = x >= width - 2;
            const anchor = atLeftEdge ? "start" : atRightEdge ? "end" : "middle";
            const xAdj = atLeftEdge ? x + 3 : atRightEdge ? x - 3 : x;
            return (
              <g key={m}>
                <line x1={x} x2={x} y1={1} y2={6} stroke="#94a3b8" strokeWidth="1" />
                <text x={xAdj} y={AXIS_H - 6} textAnchor={anchor} fontSize="10" fill="#64748b">
                  {hourLabel(m)}
                </text>
              </g>
            );
          });
        })()}
      </>
    );
  }

  // Splits one train's journey into segments inside the current time window:
  // "dwell" (stopped at a station) and "travel" (between two stations).
  function buildTrainPlot(trainNo, sourceSchedules) {
    const allStops = sourceSchedules
      .filter((s) => s.trainNo === trainNo && rowIndexOf[s.station] !== undefined)
      .map((s) => ({
        station: s.station,
        day: s.day,
        entryC: toContinuousEntry(s),
        exitC: toContinuousExit(s),
        y: yOf(rowIndexOf[s.station]),
        distance: distanceOf[s.station],
      }))
      .sort((a, b) => a.entryC - b.entryC);

    const stops = allStops.filter((s) => s.entryC >= start && s.entryC <= end);

    const segments = [];
    stops.forEach((s, i) => {
      if (s.exitC > s.entryC) {
        segments.push({ type: "dwell", x1: clampX(xOf(s.entryC)), y1: s.y, x2: clampX(xOf(s.exitC)), y2: s.y });
      }
      const next = stops[i + 1];
      if (next) {
        segments.push({ type: "travel", x1: clampX(xOf(s.exitC)), y1: s.y, x2: clampX(xOf(next.entryC)), y2: next.y });
      }
    });

    return { stops, segments };
  }

  // Totals for the journey popup: distance, elapsed/dwell/running time, speeds.
  function computeJourneySummary(stops) {
    if (stops.length === 0) return null;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const distance = Math.abs(last.distance - first.distance);
    const elapsedMin = last.exitC - first.entryC;
    const dwellMin = stops.reduce((sum, s) => sum + (s.exitC - s.entryC), 0);
    const runningMin = Math.max(0, elapsedMin - dwellMin);
    const avgSpeedOverall = elapsedMin > 0 ? distance / (elapsedMin / 60) : 0;
    const avgSpeedRunning = runningMin > 0 ? distance / (runningMin / 60) : 0;
    return {
      startStation: first.station,
      endStation: last.station,
      startTime: formatClock(first.entryC),
      endTime: formatClock(last.exitC),
      stopsCount: stops.length,
      distance,
      elapsedMin,
      dwellMin,
      runningMin,
      avgSpeedOverall,
      avgSpeedRunning,
    };
  }

  function sameDeps(a, b) {
    return a !== null && a.length === b.length && a.every((v, i) => v === b[i]);
  }

  // Plots are recomputed only when their inputs change.
  const trainPlotsDeps = [visibleSchedules, rowIndexOf, distanceOf, start, end, width];
  if (!sameDeps(trainPlotsCacheRef.current.deps, trainPlotsDeps)) {
    trainPlotsCacheRef.current = {
      deps: trainPlotsDeps,
      value: [...new Set(visibleSchedules.map((s) => s.trainNo))].map((trainNo) => ({
        trainNo,
        color: colorOf(trainNo),
        ...buildTrainPlot(trainNo, visibleSchedules),
      })),
    };
  }
  const trainPlots = trainPlotsCacheRef.current.value;

  const proposedTrainPlotsDeps = [showProposed, visibleProposedSchedules, rowIndexOf, distanceOf, start, end, width];
  if (!sameDeps(proposedTrainPlotsCacheRef.current.deps, proposedTrainPlotsDeps)) {
    proposedTrainPlotsCacheRef.current = {
      deps: proposedTrainPlotsDeps,
      value: showProposed
        ? [...new Set(visibleProposedSchedules.map((s) => s.trainNo))].map((trainNo) => ({
            trainNo,
            color: colorOf(trainNo),
            ...buildTrainPlot(trainNo, visibleProposedSchedules),
          }))
        : [],
    };
  }
  const proposedTrainPlots = proposedTrainPlotsCacheRef.current.value;

  const orderedTrainPlots = [...trainPlots].sort((a, b) => (isHighlighted(a.trainNo) ? 1 : 0) - (isHighlighted(b.trainNo) ? 1 : 0));
  const orderedProposedTrainPlots = [...proposedTrainPlots].sort((a, b) => (isHighlighted(a.trainNo) ? 1 : 0) - (isHighlighted(b.trainNo) ? 1 : 0));

  // Exports the current view as a vector A4-landscape PDF drawn with pdf-lib.
  // Every page lists a group of stations; if the time range is too wide, it is
  // split across extra pages and lines are clipped exactly at the page edges.
  // When the whole time range fits on one page width, only the graph's x-axis is
  // stretched so the page has no blank strip on the right.
  //
  // pdf-lib is loaded with a dynamic import() for the same reason as pdf.js above.
  const handleDownloadPdf = async () => {
    if (pdfBusy) return;
    setPdfStatus(null);
    if (routeData.length === 0) {
      setPdfStatus({ ok: false, msg: "Upload route data first - there's nothing to draw yet." });
      return;
    }

    setPdfBusy(true);
    try {
      const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

      const hex = (h) => {
        const clean = h.replace("#", "");
        const r = parseInt(clean.substring(0, 2), 16) / 255;
        const g = parseInt(clean.substring(2, 4), 16) / 255;
        const b = parseInt(clean.substring(4, 6), 16) / 255;
        return rgb(r, g, b);
      };
      const GREY_TEXT = rgb(0.39, 0.45, 0.55);
      const GREY_LINE = rgb(0.58, 0.64, 0.72);
      const DARK_TEXT = rgb(0.11, 0.17, 0.23);
      const WHITE = rgb(1, 1, 1);

      const LEFT_MARGIN = 125;
      const RIGHT_MARGIN = 110;
      const TITLE_H = 34;
      const graphWidthPx = width;

      const PAGE_W = 841.89;
      const PAGE_H = 595.28;
      const MARGIN = 24;
      const maxW = PAGE_W - MARGIN * 2;
      const maxH = PAGE_H - MARGIN * 2;

      // Fixed scale (PDF points per graph pixel) so text stays readable; more
      // content means more pages rather than smaller print.
      const BASE_SCALE = 0.55;
      const MAX_SCALE = 1.1;
      const chromeHeightPx = TITLE_H + HEADER_H + AXIS_H + AXIS_H;

      const stationsPerPage = Math.max(1, Math.floor((maxH - chromeHeightPx * BASE_SCALE) / (ROW_SPACING * BASE_SCALE)));
      const numRowPages = Math.max(1, Math.ceil(routeData.length / stationsPerPage));

      const trainLabel = !selectedTrain || selectedTrain === "ALL" ? "All Trains" : formatTrainNo(selectedTrain);
      const viewLabel =
        view === "week" ? "Whole Week" : view === "day" ? labelForDay(dayIndex) : `${labelForDay(dayIndex)} \u00B7 Shift ${shift}`;
      const title = `CRIS Train Schedule \u2014 ${trainLabel} \u2014 ${viewLabel}`;
      const generatedAt = new Date().toLocaleString();

      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const clipAxis = (x1, y1, x2, y2, min, max, onX) => {
        const a1 = onX ? x1 : y1, a2 = onX ? x2 : y2;
        let lo = a1, hi = a2, swapped = false;
        let p1 = [x1, y1], p2 = [x2, y2];
        if (lo > hi) { [p1, p2] = [p2, p1]; [lo, hi] = [hi, lo]; swapped = true; }
        if (hi < min || lo > max) return null;
        const d = hi - lo || 1;
        let np1 = p1.slice(), np2 = p2.slice();
        if (lo < min) {
          const t = (min - lo) / d;
          const nx = p1[0] + t * (p2[0] - p1[0]);
          const ny = p1[1] + t * (p2[1] - p1[1]);
          np1 = [nx, ny];
        }
        if (hi > max) {
          const t = (max - lo) / d;
          const nx = p1[0] + t * (p2[0] - p1[0]);
          const ny = p1[1] + t * (p2[1] - p1[1]);
          np2 = [nx, ny];
        }
        return [np1[0], np1[1], np2[0], np2[1]];
      };
      const clipToRect = (x1, y1, x2, y2, xMin, xMax, yMin, yMax) => {
        const afterX = clipAxis(x1, y1, x2, y2, xMin, xMax, true);
        if (!afterX) return null;
        const afterY = clipAxis(afterX[0], afterX[1], afterX[2], afterX[3], yMin, yMax, false);
        return afterY;
      };

      const fullContentWpx = LEFT_MARGIN + graphWidthPx + RIGHT_MARGIN;
      const widthFitScale = maxW / fullContentWpx;

      const uniformGroupContentH = chromeHeightPx + stationsPerPage * ROW_SPACING;
      const uniformScale = Math.max(BASE_SCALE, Math.min(MAX_SCALE, maxH / uniformGroupContentH));

      const rowGroups = [];
      for (let rg = 0; rg < numRowPages; rg++) {
        const stationStart = rg * stationsPerPage;
        const stationsInGroup = Math.min(stationsPerPage, routeData.length - stationStart);
        const groupContentH = chromeHeightPx + stationsInGroup * ROW_SPACING;
        const heightFitScale = Math.max(BASE_SCALE, Math.min(MAX_SCALE, maxH / groupContentH));

        let groupScale;
        let numColPages;
        let sliceW;
        if (numRowPages > 1) {
          groupScale = uniformScale;
          if (fullContentWpx * groupScale <= maxW) {
            numColPages = 1;
            sliceW = Math.max(50, maxW / groupScale - LEFT_MARGIN - RIGHT_MARGIN);
          } else {
            const pageContentWpx = maxW / groupScale;
            sliceW = Math.max(50, pageContentWpx - LEFT_MARGIN - RIGHT_MARGIN);
            numColPages = Math.min(60, Math.max(1, Math.ceil(graphWidthPx / sliceW)));
          }
        } else if (fullContentWpx * heightFitScale <= maxW) {
          groupScale = Math.max(BASE_SCALE, Math.min(MAX_SCALE, Math.min(widthFitScale, maxH / groupContentH)));
          sliceW = Math.max(50, maxW / groupScale - LEFT_MARGIN - RIGHT_MARGIN);
          numColPages = 1;
        } else {
          groupScale = heightFitScale;
          const pageContentWpx = maxW / groupScale;
          sliceW = Math.max(50, pageContentWpx - LEFT_MARGIN - RIGHT_MARGIN);
          numColPages = Math.min(60, Math.max(1, Math.ceil(graphWidthPx / sliceW)));
        }
        rowGroups.push({ stationStart, stationsInGroup, groupScale, sliceW, numColPages });
      }

      const allSegmentSets = [orderedTrainPlots.map((t) => t.segments)];
      if (showProposed) allSegmentSets.push(orderedProposedTrainPlots.map((t) => t.segments));
      const flatSegments = allSegmentSets.flat(2);
      const pageHasContent = (xStart, xEnd, yMin, yMax) =>
        flatSegments.some((s) => clipToRect(s.x1, s.y1, s.x2, s.y2, xStart, xEnd, yMin, yMax) !== null);

      const candidatePages = [];
      rowGroups.forEach((g) => {
        const groupGraphHeight = g.stationsInGroup * ROW_SPACING;
        const groupTop = g.stationStart * ROW_SPACING;
        const groupBottom = groupTop + groupGraphHeight;
        for (let cp = 0; cp < g.numColPages; cp++) {
          const xStart = cp * g.sliceW;
          const thisSliceW = Math.min(g.sliceW, graphWidthPx - xStart);
          const xEnd = xStart + thisSliceW;
          const spareForGraph = maxW - (LEFT_MARGIN + RIGHT_MARGIN) * g.groupScale;
          const xScale = g.numColPages === 1
            ? Math.min(g.groupScale * 6, Math.max(g.groupScale, spareForGraph / Math.max(1, thisSliceW)))
            : g.groupScale;
          candidatePages.push({
            ...g,
            xScale,
            groupGraphHeight,
            groupTop,
            groupBottom,
            xStart,
            xEnd,
            thisSliceW,
            hasContent: pageHasContent(xStart, xEnd, groupTop, groupBottom),
          });
        }
      });
      const anyContentAnywhere = candidatePages.some((p) => p.hasContent);
      const pagesToRender = anyContentAnywhere ? candidatePages.filter((p) => p.hasContent) : candidatePages;
      const totalPages = pagesToRender.length;

      let pageNum = 0;
      for (const pg of pagesToRender) {
        {
          const { stationStart, stationsInGroup, groupScale, groupGraphHeight, xStart, xEnd, thisSliceW, xScale } = pg;
          const stationsThisGroup = routeData.slice(stationStart, stationStart + stationsInGroup);

          pageNum++;
          const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
          const scale = groupScale;

          const graphEndLx = LEFT_MARGIN + thisSliceW;
          const xPdf = (lx) => {
            if (lx <= LEFT_MARGIN) return MARGIN + lx * scale;
            if (lx <= graphEndLx) return MARGIN + LEFT_MARGIN * scale + (lx - LEFT_MARGIN) * xScale;
            return MARGIN + LEFT_MARGIN * scale + thisSliceW * xScale + (lx - graphEndLx) * scale;
          };
          const toPdf = (lx, ly) => ({ x: xPdf(lx), y: PAGE_H - MARGIN - ly * scale });

          const drawRect = (lx, ly, w, h, color, opacity = 1) => {
            const bottomLeft = toPdf(lx, ly + h);
            page.drawRectangle({ x: bottomLeft.x, y: bottomLeft.y, width: xPdf(lx + w) - xPdf(lx), height: h * scale, color, opacity });
          };
          const drawLn = (lx1, ly1, lx2, ly2, color, thickness, opacity = 1, dashArray) => {
            const a = toPdf(lx1, ly1);
            const b = toPdf(lx2, ly2);
            page.drawLine({
              start: a,
              end: b,
              color,
              thickness: Math.max(0.4, thickness * scale),
              opacity,
              dashArray: dashArray ? dashArray.map((d) => Math.max(0.4, d * scale)) : undefined,
            });
          };
          const drawTxt = (text, lx, ly, { size = 9, bold = false, color = DARK_TEXT, anchor = "start", opacity = 1 } = {}) => {
            const useFont = bold ? fontBold : font;
            const pt = toPdf(lx, ly);
            let x = pt.x;
            if (anchor === "middle") x -= useFont.widthOfTextAtSize(text, size) / 2;
            else if (anchor === "end") x -= useFont.widthOfTextAtSize(text, size);
            page.drawText(text, { x, y: pt.y, size, font: useFont, color, opacity });
          };

          const rightPanelX = LEFT_MARGIN + thisSliceW;
          const graphTop = TITLE_H + HEADER_H + AXIS_H;
          const bottomAxisY = graphTop + groupGraphHeight;

          const pageTitle = rowGroups.length > 1 ? `${title} \u2014 Stations ${stationStart + 1}\u2013${stationStart + stationsInGroup} \u2014 Page ${pageNum} of ${totalPages}` : `${title} \u2014 Page ${pageNum} of ${totalPages}`;
          drawTxt(pageTitle, 12, 13, { size: 12, bold: true, color: hex("#0b3d68") });
          drawTxt(`Generated ${generatedAt}`, 12, TITLE_H - 6, { size: 7, color: GREY_TEXT });
          drawTxt("Station", 6, TITLE_H + HEADER_H / 2 + 3, { size: 8, bold: true, color: hex("#1e5b34") });
          drawTxt("Time", 6, TITLE_H + HEADER_H + AXIS_H / 2 + 3, { size: 8, bold: true, color: hex("#1e5b34") });
          drawTxt("km", rightPanelX + RIGHT_MARGIN / 2, TITLE_H + HEADER_H / 2 + 3, { size: 8, bold: true, color: hex("#1e5b34"), anchor: "middle" });
          drawTxt("Time", 6, bottomAxisY + AXIS_H / 2 + 3, { size: 8, bold: true, color: hex("#1e5b34") });

          stationsThisGroup.forEach((s, i) => {
            const globalIdx = stationStart + i;
            const rowTop = TITLE_H + HEADER_H + AXIS_H + i * ROW_SPACING;
            const rowCenter = rowTop + ROW_SPACING / 2;
            const gapLabel = globalIdx === 0 ? "start" : s.gapFromPrevious.toFixed(2);
            drawTxt(gapLabel, 8, rowTop + 4, { size: 7, bold: true, color: hex("#1f4e79") });
            drawTxt(s.station, LEFT_MARGIN - 8, rowCenter + 3, { size: 9, bold: true, color: DARK_TEXT, anchor: "end" });
          });

          stationsThisGroup.forEach((s, i) => {
            const rowTop = TITLE_H + HEADER_H + AXIS_H + i * ROW_SPACING;
            const rowCenter = rowTop + ROW_SPACING / 2;
            drawTxt(s.station, rightPanelX + 8, rowCenter + 3, { size: 9, bold: true, color: DARK_TEXT });
            drawTxt(String(s.cumulativeDistance), rightPanelX + RIGHT_MARGIN - 10, rowCenter + 3, { size: 8, color: GREY_TEXT, anchor: "end" });
          });

          daySegments.forEach((seg) => {
            const gx0 = Math.max(xOf(seg.from), xStart);
            const gx1 = Math.min(xOf(seg.to), xEnd);
            if (gx1 <= gx0) return;
            const c = BAND_COLORS[seg.idx % BAND_COLORS.length];
            const lx = LEFT_MARGIN + (gx0 - xStart);
            const w = gx1 - gx0;
            drawRect(lx, TITLE_H, w, HEADER_H, hex(c.header));
            if (w * xScale > 34) {
              const label = view === "shift" ? `${labelForDay(seg.idx)} Shift ${shift}` : labelForDay(seg.idx);
              drawTxt(label, lx + w / 2, TITLE_H + HEADER_H / 2 + 3, { size: 8, bold: true, color: WHITE, anchor: "middle" });
            }
          });

          [TITLE_H + HEADER_H, bottomAxisY].forEach((axisY) => {
            daySegments.forEach((seg) => {
              const gx0 = Math.max(xOf(seg.from), xStart);
              const gx1 = Math.min(xOf(seg.to), xEnd);
              if (gx1 <= gx0) return;
              const c = BAND_COLORS[seg.idx % BAND_COLORS.length];
              const lx = LEFT_MARGIN + (gx0 - xStart);
              drawRect(lx, axisY, gx1 - gx0, AXIS_H, hex(c.bg));
            });
            if (zoomed) {
              for (let m = start; m <= end; m += MINOR_TICK_MIN) {
                if (m % tickStep === 0) continue;
                const gx = xOf(m);
                if (gx < xStart || gx > xEnd) continue;
                const lx = LEFT_MARGIN + (gx - xStart);
                drawLn(lx, axisY + AXIS_H * 0.6, lx, axisY + AXIS_H, GREY_LINE, 0.75);
              }
            }
            for (let m = start; m <= end; m += tickStep) {
              const gx = xOf(m);
              if (gx < xStart - 0.01 || gx > xEnd + 0.01) continue;
              const lx = LEFT_MARGIN + (gx - xStart);
              drawLn(lx, axisY + 1, lx, axisY + 6, GREY_LINE, 1);
              drawTxt(hourLabel(m), lx, axisY + AXIS_H - 5, { size: 7, color: GREY_TEXT, anchor: "middle" });
            }
          });

          daySegments.forEach((seg) => {
            const gx0 = Math.max(xOf(seg.from), xStart);
            const gx1 = Math.min(xOf(seg.to), xEnd);
            if (gx1 <= gx0) return;
            const lx = LEFT_MARGIN + (gx0 - xStart);
            drawRect(lx, graphTop, gx1 - gx0, groupGraphHeight, hex(BAND_COLORS[seg.idx % BAND_COLORS.length].bg));
          });
          daySegments.slice(1).forEach((seg) => {
            const gx = xOf(seg.from);
            if (gx < xStart || gx > xEnd) return;
            const lx = LEFT_MARGIN + (gx - xStart);
            drawLn(lx, graphTop, lx, graphTop + groupGraphHeight, GREY_LINE, 1.25);
          });
          if (zoomed) {
            for (let m = start; m <= end; m += MINOR_TICK_MIN) {
              if (m % tickStep === 0) continue;
              const gx = xOf(m);
              if (gx < xStart || gx > xEnd) continue;
              const lx = LEFT_MARGIN + (gx - xStart);
              drawLn(lx, graphTop, lx, graphTop + groupGraphHeight, rgb(0.906, 0.922, 0.941), 0.75);
            }
            for (let m = start; m <= end; m += tickStep) {
              const gx = xOf(m);
              if (gx < xStart || gx > xEnd) continue;
              const lx = LEFT_MARGIN + (gx - xStart);
              drawLn(lx, graphTop, lx, graphTop + groupGraphHeight, rgb(0.78, 0.816, 0.855), 1);
            }
          }
          stationsThisGroup.forEach((s, i) => {
            const ly = graphTop + i * ROW_SPACING + ROW_SPACING / 2;
            drawLn(LEFT_MARGIN, ly, LEFT_MARGIN + thisSliceW, ly, rgb(0.82, 0.84, 0.86), 1, 1, [4, 3]);
          });

          const groupTop = stationStart * ROW_SPACING;
          const groupBottom = groupTop + groupGraphHeight;

          orderedTrainPlots.forEach(({ color, segments }) => {
            const c = hex(color);
            segments.forEach((s) => {
              const clipped = clipToRect(s.x1, s.y1, s.x2, s.y2, xStart, xEnd, groupTop, groupBottom);
              if (!clipped) return;
              const [cx1, cy1, cx2, cy2] = clipped;
              const lx1 = LEFT_MARGIN + (cx1 - xStart);
              const lx2 = LEFT_MARGIN + (cx2 - xStart);
              const ly1 = graphTop + (cy1 - groupTop);
              const ly2 = graphTop + (cy2 - groupTop);
              if (s.type === "dwell") {
                drawLn(lx1, ly1, lx2, ly2, c, zoomed ? 4 : 3.5, 1, [2, 2]);
              } else {
                drawLn(lx1, ly1, lx2, ly2, c, zoomed ? 2.5 : 2, 1);
              }
            });
          });

          if (showProposed) {
            orderedProposedTrainPlots.forEach(({ color, segments }) => {
              const c = hex(color);
              segments.forEach((s) => {
                const clipped = clipToRect(s.x1, s.y1, s.x2, s.y2, xStart, xEnd, groupTop, groupBottom);
                if (!clipped) return;
                const [cx1, cy1, cx2, cy2] = clipped;
                const lx1 = LEFT_MARGIN + (cx1 - xStart);
                const lx2 = LEFT_MARGIN + (cx2 - xStart);
                const ly1 = graphTop + (cy1 - groupTop);
                const ly2 = graphTop + (cy2 - groupTop);
                drawLn(lx1, ly1, lx2, ly2, c, zoomed ? 2.5 : 2, 0.85, [3, 2]);
              });
            });
          }
        }
      }

      const pdfBytes = await pdfDoc.save();
      const pdfBlob = new Blob([pdfBytes], { type: "application/pdf" });
      const safeTrain = (trainLabel || "train").replace(/[^a-z0-9]+/gi, "-");
      const safeView = viewLabel.replace(/[^a-z0-9]+/gi, "-");
      const filename = `CRIS_${safeTrain}_${safeView}.pdf`;

      const previewUrl = URL.createObjectURL(pdfBlob);
      setPdfPreview({ url: previewUrl, blob: pdfBlob, filename, numPages: totalPages });
      setPdfStatus(null);
    } catch (err) {
      setPdfStatus({ ok: false, msg: err?.message ? `Couldn't generate the PDF: ${err.message}` : "Couldn't generate the PDF. Please try again." });
    } finally {
      setPdfBusy(false);
    }
  };

  // The PDF is shown in a preview modal first; Download in the modal saves it.
  const cancelPdfPreview = () => {
    if (pdfPreview) URL.revokeObjectURL(pdfPreview.url);
    setPdfPreview(null);
  };

  // Tries, in order: the host's own save capability (window.claude.use
  // "downloads" - required when this app runs inside a sandboxed preview
  // frame, where a raw <a download> click is silently blocked), a normal
  // browser download, then opening the file in a new tab as a last resort.
  // Kept inline (not imported from utils/saveFile.js) because this file is
  // also embedded as raw text in the standalone Share page, which only
  // tolerates a single static `react` import - see exportSharePage.js.
  const trySaveGeneratedFile = async ({ filename, data }) => {
    const attemptLog = [];

    if (typeof window !== "undefined" && typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
        return { ok: true, attemptLog: ["Save dialog: succeeded"] };
      } catch (saveErr) {
        if (saveErr?.name === "AbortError") {
          return { ok: false, declined: true, attemptLog: ["Save dialog: you declined the save prompt"] };
        }
        attemptLog.push(`Save dialog: failed (${saveErr?.message || "unknown"})`);
      }
    }

    if (typeof window !== "undefined" && window.claude && typeof window.claude.use === "function") {
      try {
        const downloadsApi = await window.claude.use("downloads");
        if (downloadsApi) {
          try {
            await downloadsApi.save({ filename, data });
            return { ok: true, attemptLog: [...attemptLog, "Save dialog: succeeded"] };
          } catch (saveErr) {
            if (saveErr && saveErr.code === "declined") {
              return { ok: false, declined: true, attemptLog: [...attemptLog, "Save dialog: you declined the save prompt"] };
            }
            attemptLog.push(`Save dialog: failed (${saveErr?.code || saveErr?.message || "unknown"})`);
          }
        } else {
          attemptLog.push("Save dialog: not available in this view");
        }
      } catch (useErr) {
        attemptLog.push(`Save dialog: unavailable (${useErr?.message || "unknown"})`);
      }
    } else {
      attemptLog.push("Save dialog: not present in this context");
    }

    try {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = dlUrl;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(dlUrl), 4000);
      return { ok: true, attemptLog: [...attemptLog, "Browser download: triggered"] };
    } catch (dlErr) {
      attemptLog.push(`Browser download: failed (${dlErr?.message || "unknown"})`);
    }

    try {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const dlUrl = URL.createObjectURL(blob);
      const opened = window.open(dlUrl, "_blank", "noopener");
      if (opened) {
        return { ok: true, attemptLog: [...attemptLog, "Opened in a new tab - use your browser's Save/Share to keep it"] };
      }
      attemptLog.push("Open in new tab: blocked by the browser");
    } catch (openErr) {
      attemptLog.push(`Open in new tab: failed (${openErr?.message || "unknown"})`);
    }

    return { ok: false, attemptLog };
  };

  const confirmPdfDownload = async () => {
    if (!pdfPreview) return;
    const { blob, filename, numPages } = pdfPreview;

    const result = await trySaveGeneratedFile({ filename, data: blob });

    if (result.declined) {
      setPdfStatus({ ok: true, msg: "Download cancelled." });
    } else if (result.ok) {
      const pageWord = numPages === 1 ? "1 page" : `${numPages} pages`;
      setPdfStatus({ ok: true, msg: `${filename} (${pageWord}) - ${result.attemptLog[result.attemptLog.length - 1]}` });
    } else {
      setPdfStatus({ ok: false, msg: `Every save method failed in this view. Details: ${result.attemptLog.join(" | ")}` });
    }

    URL.revokeObjectURL(pdfPreview.url);
    setPdfPreview(null);
  };

  return (
    <div className={`graph-wrap${isFullscreen ? " graph-wrap-fullscreen" : ""}`} ref={graphWrapRef}>
      <div className="graph-toolbar">
        {trainList.length > 0 && (
          <select value={selectedTrain ?? ""} onChange={(e) => setSelectedTrain(e.target.value)}>
            {trainList.length <= MAX_TRAINS_FOR_ALL_OPTION && <option value="ALL">All trains</option>}
            {trainList.map((t) => (
              <option key={t} value={t}>{formatTrainNo(t)}</option>
            ))}
          </select>
        )}
        <label className={`view-btn view-checkbox ${weekActivated ? "active" : ""}`}>
          <input
            type="checkbox"
            checked={weekActivated}
            onChange={() => {
              if (weekActivated) {
                // Unchecking the root collapses everything back to the start.
                setWeekActivated(false);
                setDayIndex(null);
                setShiftChecked(false);
                setView("week");
              } else {
                setWeekActivated(true);
                setView("week");
              }
            }}
          />
          Whole Week
        </label>
        {!weekActivated &&
          WEEKDAY_NAMES.map((name, i) => (
            <label key={name} className={`view-btn view-checkbox ${dayIndex === i ? "active" : ""}`}>
              <input
                type="checkbox"
                checked={dayIndex === i}
                onChange={() => {
                  if (dayIndex === i) {
                    // Unchecking the selected day falls back to the week view.
                    setDayIndex(null);
                    setShiftChecked(false);
                    setView("week");
                  } else {
                    setDayIndex(i);
                    setShiftChecked(false);
                    setView("day");
                  }
                }}
              />
              {name}
            </label>
          ))}
        {dayIndex !== null && (
          <>
            {[1, 2, 3].map((k) => (
              <label key={k} className={`view-btn view-checkbox ${shiftChecked && shift === k ? "active" : ""}`}>
                <input
                  type="checkbox"
                  checked={shiftChecked && shift === k}
                  onChange={() => {
                    if (shiftChecked && shift === k) {
                      // Unchecking the selected shift falls back to the full-day view.
                      setShiftChecked(false);
                      setView("day");
                    } else {
                      setShift(k);
                      setShiftChecked(true);
                      setView("shift");
                    }
                  }}
                />
                {k === 1 ? "Shift 1 (00–08h)" : k === 2 ? "Shift 2 (08–16h)" : "Shift 3 (16–24h)"}
              </label>
            ))}
          </>
        )}
        {proposedSchedules.length > 0 && (
          <button
            className={`view-btn ${showProposed ? "active" : ""}`}
            onClick={() => setShowProposed((v) => !v)}
          >
            {showProposed ? "Hide" : "Show"} Proposed
          </button>
        )}
        <button
          className="view-btn fullscreen-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit full screen" : "View full screen"}
          aria-label={isFullscreen ? "Exit full screen" : "View full screen"}
        >
          {isFullscreen ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 3v4a2 2 0 0 1-2 2H3" />
              <path d="M21 9h-4a2 2 0 0 1-2-2V3" />
              <path d="M3 15h4a2 2 0 0 1 2 2v4" />
              <path d="M15 21v-4a2 2 0 0 1 2-2h4" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M16 3h3a2 2 0 0 1 2 2v3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
            </svg>
          )}
        </button>
        <button
          className="view-btn download-pdf-btn"
          onClick={handleDownloadPdf}
          disabled={pdfBusy || routeData.length === 0}
          title="Download the current view (selected train + view period) as an A4 PDF"
          aria-label="Download current view as PDF"
        >
          {pdfBusy ? (
            <span className="download-pdf-spinner" aria-hidden="true" />
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="M7 10l5 5 5-5" />
              <path d="M4 19h16" />
            </svg>
          )}
        </button>
        {pdfStatus && !pdfStatus.ok && (
          <span className="download-pdf-status err" role="status">
            {pdfStatus.msg}
          </span>
        )}
      </div>

      <div className="frame">
        <div className="h-band">
          <div className="corner corner-left">Station</div>
          <div className="h-scroll h-scroll-hidden" ref={topRef} onScroll={onTopScroll}>
            <svg width={width} height={HEADER_H}>
              {daySegments.map((seg) => {
                const x0 = xOf(seg.from), x1 = xOf(seg.to);
                const c = BAND_COLORS[seg.idx % BAND_COLORS.length];
                return (
                  <g key={seg.idx}>
                    <rect
                      x={x0} y={0} width={x1 - x0} height={HEADER_H}
                      fill={c.header} className="day-header"
                      onClick={() => { setDayIndex(seg.idx); setView("day"); }}
                    />
                    {x1 - x0 > 36 && (
                      <text x={(x0 + x1) / 2} y={HEADER_H / 2 + 4} textAnchor="middle" fontSize="11" fill="#fff" fontWeight="700">
                        {view === "shift" ? `${labelForDay(seg.idx)} Shift ${shift}` : labelForDay(seg.idx)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="corner">km</div>
        </div>

        <div className="h-band">
          <div className="corner corner-left">Time</div>
          <div className="h-scroll h-scroll-hidden" ref={timeTopRef} onScroll={onTimeTopScroll}>
            <svg width={width} height={AXIS_H}>
              {renderTimeAxisSvg()}
            </svg>
          </div>
          <div className="corner">-</div>
        </div>

        <div className="mid-row" style={{ height: isFullscreen ? "calc(100vh - 180px)" : midHeight }}>
          <div className="v-scroll v-scroll-hidden v-scroll-left" ref={leftRef} onScroll={onLeftScroll}>
            <div className="side-body" style={{ height: graphHeight }}>
              {routeData.map((s, i) => (
                <div key={`dist-${s.station}`} className="side-gap-left" style={{ top: yOf(i) - ROW_SPACING / 2 - 9 }}>
                  {i === 0 ? "" : s.gapFromPrevious.toFixed(2)}
                </div>
              ))}
              {routeData.map((s, i) => (
                <div key={s.station} className="side-label side-label-left" style={{ top: yOf(i) - 9 }}>
                  <strong>{s.station}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="main-scroll h-scroll-hidden v-scroll-hidden" ref={mainRef} onScroll={onMainScroll}>
            <svg className="graph-svg" width={width} height={graphHeight}>
              {daySegments.map((seg) => {
                const x0 = xOf(seg.from), x1 = xOf(seg.to);
                return <rect key={seg.idx} x={x0} y={0} width={x1 - x0} height={graphHeight} fill={BAND_COLORS[seg.idx % BAND_COLORS.length].bg} />;
              })}
              {daySegments.slice(1).map((seg) => (
                <line key={`daydiv-${seg.idx}`} x1={xOf(seg.from)} x2={xOf(seg.from)} y1={0} y2={graphHeight} stroke="#94a3b8" strokeWidth="1.25" />
              ))}

              {zoomed && (() => {
                const minorLines = [];
                for (let m = start; m <= end; m += MINOR_TICK_MIN) {
                  if (m % tickStep !== 0) minorLines.push(m);
                }
                return minorLines.map((m) => (
                  <line key={`minor-${m}`} x1={xOf(m)} x2={xOf(m)} y1={0} y2={graphHeight} stroke="#e7ebf0" strokeWidth="0.75" />
                ));
              })()}
              {zoomed && (() => {
                const majorLines = [];
                for (let m = start; m <= end; m += tickStep) majorLines.push(m);
                return majorLines.map((m) => (
                  <line key={`major-${m}`} x1={xOf(m)} x2={xOf(m)} y1={0} y2={graphHeight} stroke="#c7d0da" strokeWidth="1" />
                ));
              })()}

              {routeData.map((s, i) => (
                <line key={s.station} x1={0} x2={width} y1={yOf(i)} y2={yOf(i)} stroke="#d1d5db" strokeDasharray="4 3" />
              ))}

              {orderedTrainPlots.map(({ trainNo, color, stops, segments }) => {
                const highlighted = isHighlighted(trainNo);
                const travelWidth = (zoomed ? 2.5 : 2) + (highlighted ? 1.75 : 0);
                const dwellWidth = (zoomed ? 4 : 3.5) + (highlighted ? 1.75 : 0);
                const dimmed = dimOthers && !highlighted;
                const pin = (e) => {
                  e.stopPropagation();
                  setPinnedTrain(trainNo);
                };
                const openJourneySummary = (e) => {
                  e.preventDefault();
                  setPinnedTrain(trainNo);
                  const summary = computeJourneySummary(stops);
                  if (summary) setJourneyPopup({ clientX: e.clientX, clientY: e.clientY, trainNo, isProposed: false, ...summary });
                };
                return (
                  <g
                    key={trainNo}
                    className={`train-group${highlighted ? " train-group-highlighted" : ""}`}
                    opacity={dimmed ? 0.3 : 1}
                  >
                    {segments.map((s, i) => (
                      <line
                        key={`hit-${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                        stroke="transparent" strokeWidth={32} pointerEvents="stroke"
                        style={{ cursor: "pointer" }}
                        onClick={pin} onContextMenu={openJourneySummary}
                      />
                    ))}

                    {segments.filter((s) => s.type === "travel").map((s, i) => (
                      <line key={`t-${i}`} className="train-visible-line" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={color} strokeWidth={travelWidth} />
                    ))}
                    {segments.filter((s) => s.type === "dwell").map((s, i) => (
                      <line key={`d-${i}`} className="train-dwell-line" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={color} strokeWidth={dwellWidth} strokeDasharray="2 2" strokeLinecap="round" />
                    ))}
                    {zoomed && stops[0] && (
                      <text x={clampX(xOf(stops[0].entryC)) + 5} y={stops[0].y - 5} fontSize="11" fill={color} fontWeight="600">
                        {formatTrainNo(trainNo)}
                      </text>
                    )}
                  </g>
                );
              })}

              {showProposed && orderedProposedTrainPlots.map(({ trainNo, color, stops, segments }) => {
                const highlighted = isHighlighted(trainNo);
                const lineWidth = (zoomed ? 2.5 : 2) + (highlighted ? 1.75 : 0);
                const dimmed = dimOthers && !highlighted;
                const pin = (e) => {
                  e.stopPropagation();
                  setPinnedTrain(trainNo);
                };
                const openJourneySummary = (e) => {
                  e.preventDefault();
                  setPinnedTrain(trainNo);
                  const summary = computeJourneySummary(stops);
                  if (summary) setJourneyPopup({ clientX: e.clientX, clientY: e.clientY, trainNo, isProposed: true, ...summary });
                };
                return (
                  <g
                    key={`proposed-${trainNo}`}
                    className={`train-group${highlighted ? " train-group-highlighted" : ""}`}
                    opacity={dimmed ? 0.25 : 0.85}
                  >
                    {segments.map((s, i) => (
                      <line
                        key={`hit-p-${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                        stroke="transparent" strokeWidth={32} pointerEvents="stroke"
                        style={{ cursor: "pointer" }}
                        onClick={pin} onContextMenu={openJourneySummary}
                      />
                    ))}
                    {segments.map((s, i) => (
                      <line
                        key={`p-${i}`} className="train-visible-line" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                        stroke={color} strokeWidth={lineWidth}
                        strokeDasharray="1 4" strokeLinecap="round"
                      />
                    ))}
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="v-scroll" ref={rightRef} onScroll={onRightScroll}>
            <div className="side-body" style={{ height: graphHeight }}>
              {routeData.map((s, i) => (
                <div key={s.station} className="side-label side-label-right" style={{ top: yOf(i) - 16 }}>
                  <strong>{s.station}</strong>
                  <span>{s.cumulativeDistance}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="h-band">
          <div className="corner corner-left">Time</div>
          <div className="h-scroll" ref={bottomRef} onScroll={onBottomScroll}>
            <svg width={width} height={AXIS_H}>
              {renderTimeAxisSvg()}
            </svg>
          </div>
          <div className="corner">-</div>
        </div>
      </div>

      <p className="graph-tip">

        {trainList.length > MAX_TRAINS_FOR_ALL_OPTION && " This file has many trains, so pick one from the dropdown above to keep the graph fast."}
      </p>

      {journeyPopup && (
        <div
          ref={journeyPopupRef}
          className="journey-popup"
          style={{ left: journeyPopup.clientX + 10, top: journeyPopup.clientY + 10 }}
        >
          <div className="journey-popup-header">
            <span className="journey-popup-title">
              {journeyPopup.isProposed && "(Proposed) "}{formatTrainNo(journeyPopup.trainNo)}
            </span>
            <button className="journey-popup-close" onClick={() => setJourneyPopup(null)} aria-label="Close">
              &times;
            </button>
          </div>
          <div className="journey-popup-sub">Journey summary &middot; {journeyPopup.startStation} &rarr; {journeyPopup.endStation}</div>
          <table className="journey-popup-table">
            <tbody>
              <tr><td>Start</td><td>{journeyPopup.startTime} at {journeyPopup.startStation}</td></tr>
              <tr><td>End</td><td>{journeyPopup.endTime} at {journeyPopup.endStation}</td></tr>
              <tr><td>Stops</td><td>{journeyPopup.stopsCount}</td></tr>
              <tr><td>Distance</td><td>{journeyPopup.distance.toFixed(2)} km</td></tr>
              <tr><td>Duration</td><td>{journeyPopup.elapsedMin.toFixed(1)} min</td></tr>
              <tr><td>Dwell time</td><td>{journeyPopup.dwellMin.toFixed(1)} min</td></tr>
              <tr><td>Running time</td><td>{journeyPopup.runningMin.toFixed(1)} min</td></tr>
              <tr className="journey-popup-highlight-row">
                <td>Avg speed (overall)</td>
                <td>{journeyPopup.avgSpeedOverall.toFixed(1)} km/h</td>
              </tr>
              <tr className="journey-popup-highlight-row">
                <td>Avg speed (running)</td>
                <td>{journeyPopup.avgSpeedRunning.toFixed(1)} km/h</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {pdfPreview && (
        <div className="pdf-preview-backdrop" onClick={cancelPdfPreview}>
          <div className="pdf-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pdf-preview-titlebar">
              <span className="pdf-preview-titlebar-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <rect width="24" height="24" rx="3" fill="#ffffff" />
                  <text x="12" y="17" textAnchor="middle" fontSize="13" fontWeight="700" fontFamily="Arial, Helvetica, sans-serif" fill="#c0392b">PDF</text>
                </svg>
              </span>
              <span className="pdf-preview-titlebar-title">
                {pdfPreview.filename} &middot; {pdfPreview.numPages === 1 ? "1 page" : `${pdfPreview.numPages} pages`}
              </span>
              <button type="button" className="pdf-preview-close" onClick={cancelPdfPreview} aria-label="Close preview without downloading">
                &times;
              </button>
            </div>
            <div className="pdf-preview-body">
              <PdfPagesPreview blob={pdfPreview.blob} url={pdfPreview.url} />
            </div>
            <div className="pdf-preview-footer">
              <button type="button" className="btn pdf-preview-cancel-btn" onClick={cancelPdfPreview}>
                Cancel
              </button>
              <button type="button" className="btn primary pdf-preview-download-btn" onClick={confirmPdfDownload}>
                Download
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
