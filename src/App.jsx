import { useState } from "react";
import FileUploadCard from "./components/FileUploadCard.jsx";
import ScheduleGraph from "./components/ScheduleGraph.jsx";
import { readSpreadsheet, pick, parseDistance, parseTimeToMinutes } from "./utils/spreadsheet.js";
import { buildSharePageHtml } from "./utils/exportSharePage.js";
import { saveGeneratedFile } from "./utils/saveFile.js";

// Accepted column names (already lower-cased with punctuation removed) for
// each field. The first alias that matches a header wins.
const ROUTE_STATION_ALIASES = ["stationcode", "station"];
const ROUTE_DISTANCE_ALIASES = ["cumulativedistance", "distancefromsource", "distance"];

const SCHEDULE_STATION_ALIASES = ["station", "stationcode"];
const SCHEDULE_TRAIN_ALIASES = ["train", "trainno", "trainnumber", "trainid"];
const SCHEDULE_ENTRY_ALIASES = ["entrytime", "arrivaltime", "time"];
const SCHEDULE_EXIT_ALIASES = ["exittime", "departuretime", "time"];
const SCHEDULE_DAY_ALIASES = ["day", "dayofweek"];

// Root component: parses the three uploads in the browser (no backend) and
// hands the data to <ScheduleGraph>.
const App = () => {
  const [routeData, setRouteData] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [proposedSchedules, setProposedSchedules] = useState([]);
  const [shareStatus, setShareStatus] = useState(null);

  // Route file: one row per station with a distance from the origin.
  // The sheet with the most distinct valid stations is used.
  const handleRouteUpload = async (file) => {
    const scoreRouteSheet = (rows) => {
      const stations = new Set();
      rows.forEach((r) => {
        const station = pick(r, ROUTE_STATION_ALIASES);
        const distance = parseDistance(pick(r, ROUTE_DISTANCE_ALIASES));
        if (station && !Number.isNaN(distance)) stations.add(station);
      });
      return stations.size;
    };

    const { rows, truncated, totalRows, sheetName, sheetCount } = await readSpreadsheet(file, {
      chooseSheet: scoreRouteSheet,
    });

    const parsed = rows
      .map((r) => ({
        station: pick(r, ROUTE_STATION_ALIASES),
        distanceFromSource: parseDistance(pick(r, ROUTE_DISTANCE_ALIASES)),
      }))
      .filter((r) => r.station && !Number.isNaN(r.distanceFromSource));

    if (parsed.length === 0) {
      throw new Error(
        `Couldn't find usable station/distance columns in this file (checked ${sheetCount} sheet(s), ${rows.length} row(s)). Expected a column like "Station" or "StationCode", and one like "CumulativeDistance" or "Distance".`
      );
    }

    // Sort by distance first so gaps between stations are never negative,
    // then drop repeated station codes (keeping the first occurrence).
    const sorted = [...parsed].sort((a, b) => a.distanceFromSource - b.distanceFromSource);

    const seen = new Set();
    const deduped = [];
    let duplicates = 0;
    for (const r of sorted) {
      if (seen.has(r.station)) { duplicates++; continue; }
      seen.add(r.station);
      deduped.push(r);
    }

    const withCumulative = deduped.map((r, i) => ({
      ...r,
      cumulativeDistance: r.distanceFromSource,
      gapFromPrevious: i === 0 ? 0 : Math.max(0, r.distanceFromSource - deduped[i - 1].distanceFromSource),
    }));

    setRouteData(withCumulative);
    const skipped = rows.length - parsed.length;
    const parts = [`Loaded ${withCumulative.length} stations`];
    if (sheetCount > 1) parts.push(`used sheet "${sheetName}"`);
    if (skipped > 0) parts.push(`skipped ${skipped} row(s) missing a station/distance`);
    if (duplicates > 0) parts.push(`merged ${duplicates} duplicate station row(s)`);
    if (truncated) parts.push(`file had ${totalRows} rows, only the first ${rows.length} were used`);
    return { message: parts.join(" — ") };
  };

  // Shared by the baseline and proposed uploads. A row is kept only if it has a
  // station, a train and both an entry and an exit time.
  async function parseScheduleFile(file) {
    const scoreScheduleSheet = (rows) =>
      rows.filter(
        (r) =>
          pick(r, SCHEDULE_STATION_ALIASES) &&
          pick(r, SCHEDULE_TRAIN_ALIASES) &&
          parseTimeToMinutes(pick(r, SCHEDULE_ENTRY_ALIASES)) !== null &&
          parseTimeToMinutes(pick(r, SCHEDULE_EXIT_ALIASES)) !== null
      ).length;

    const { rows, truncated, totalRows, sheetName, sheetCount } = await readSpreadsheet(file, {
      chooseSheet: scoreScheduleSheet,
    });

    const parsed = rows
      .map((r) => ({
        station: pick(r, SCHEDULE_STATION_ALIASES),
        trainNo: pick(r, SCHEDULE_TRAIN_ALIASES),
        day: pick(r, SCHEDULE_DAY_ALIASES),
        entryMinutesInDay: parseTimeToMinutes(pick(r, SCHEDULE_ENTRY_ALIASES)),
        exitMinutesInDay: parseTimeToMinutes(pick(r, SCHEDULE_EXIT_ALIASES)),
      }))
      .filter(
        (r) =>
          r.station &&
          r.trainNo &&
          r.entryMinutesInDay !== null &&
          r.exitMinutesInDay !== null
      );

    if (parsed.length === 0) {
      throw new Error(
        `Couldn't find usable schedule rows in this file (checked ${sheetCount} sheet(s), ${rows.length} row(s)). Expected columns for station, train number, and entry/exit (or arrival/departure) time.`
      );
    }

    // Chronological order within each train.
    parsed.sort((a, b) => a.trainNo.localeCompare(b.trainNo) || a.entryMinutesInDay - b.entryMinutesInDay);
    return { parsed, skipped: rows.length - parsed.length, truncated, totalRows, readRows: rows.length, sheetName, sheetCount };
  }

  function summarizeUpload(label, { parsed, skipped, truncated, totalRows, readRows, sheetName, sheetCount }) {
    const parts = [`Loaded ${parsed.length} valid station-visit rows (${label})`];
    if (sheetCount > 1) parts.push(`used sheet "${sheetName}"`);
    if (skipped > 0) parts.push(`skipped ${skipped} row(s) missing required fields`);
    if (truncated) parts.push(`file had ${totalRows} rows, only the first ${readRows} were used`);
    return parts.join(" — ");
  }

  const handleOriginalUpload = async (file) => {
    const result = await parseScheduleFile(file);
    setSchedules(result.parsed);
    return { message: summarizeUpload("baseline", result) };
  };

  const handleProposedUpload = async (file) => {
    const result = await parseScheduleFile(file);
    setProposedSchedules(result.parsed);
    return { message: summarizeUpload("proposed", result) };
  };

  const handleShare = async () => {
    if (routeData.length === 0) return;
    setShareStatus(null);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `cris-schedule-share-${stamp}.html`;

    let html;
    try {
      html = buildSharePageHtml({ routeData, schedules, proposedSchedules });
    } catch (err) {
      setShareStatus({ ok: false, msg: err?.message || "Couldn't build the share file. Please try again." });
      return;
    }

    const result = await saveGeneratedFile({ filename, data: html });
    if (result.declined) {
      setShareStatus({ ok: true, msg: "Share cancelled." });
    } else if (result.ok) {
      setShareStatus({
        ok: true,
        msg: `${filename} - ${result.attemptLog[result.attemptLog.length - 1]}. Open the .html file or send it to anyone, it needs no server.`,
      });
    } else {
      setShareStatus({ ok: false, msg: `Couldn't save the share file. Details: ${result.attemptLog.join(" | ")}` });
    }
  };

  return (
    <div className="app-shell">
      <div className="tricolor-strip" />

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
          <p className="app-subtitle">Centre for Railway Information Systems &mdash; Train Schedule &amp; Route Planner</p>
        </div>
        <div className="header-actions">
          <button
            className="btn share-btn"
            onClick={handleShare}
            disabled={routeData.length === 0}
            title={routeData.length === 0 ? "Upload route data first" : "Download a shareable, upload-free copy of this page"}
          >
            Share
          </button>
          {shareStatus && !shareStatus.ok && (
            <div className="share-status err">{shareStatus.msg}</div>
          )}
        </div>
      </header>

      <section className="upload-bar">
        <span className="upload-bar-title">Upload Files</span>
        <div className="upload-bar-items">
          <FileUploadCard
            title="Original Schedule"
            hint="CSV or XLSX: original schedule (plotted as solid lines)"
            formatLabel="CSV or Excel (.csv, .xlsx, .xls)"
            layoutColumns={["Station", "Train", "EntryTime", "ExitTime", "Day"]}
            layoutRows={[
              { Station: "HWH", Train: "12301", EntryTime: "06:00", ExitTime: "06:00", Day: "Mon" },
              { Station: "BWN", Train: "12301", EntryTime: "07:07", ExitTime: "07:10", Day: "Mon" },
              { Station: "ASN", Train: "12301", EntryTime: "08:58", ExitTime: "09:01", Day: "Mon" },
            ]}
            onUpload={handleOriginalUpload}
          />
          <FileUploadCard
            title="Proposed Schedule"
            hint="CSV or XLSX: proposed changes (plotted as a dotted overlay)"
            formatLabel="CSV or Excel (.csv, .xlsx, .xls)"
            layoutColumns={["Station", "Train", "EntryTime", "ExitTime", "Day"]}
            layoutRows={[
              { Station: "HWH", Train: "12301", EntryTime: "06:00", ExitTime: "06:00", Day: "Mon" },
              { Station: "BWN", Train: "12301", EntryTime: "07:07", ExitTime: "07:10", Day: "Mon" },
              { Station: "ASN", Train: "12301", EntryTime: "08:58", ExitTime: "09:01", Day: "Mon" },
            ]}
            onUpload={handleProposedUpload}
          />
          <FileUploadCard
            title="Route Data"
            hint="CSV or XLSX: route data"
            formatLabel="CSV or Excel (.csv, .xlsx, .xls)"
            layoutColumns={["StationCode", "CumulativeDistance"]}
            layoutRows={[
              { StationCode: "HWH", CumulativeDistance: "0" },
              { StationCode: "BWN", CumulativeDistance: "67" },
              { StationCode: "ASN", CumulativeDistance: "175" },
            ]}
            onUpload={handleRouteUpload}
          />
        </div>
      </section>

      <ScheduleGraph routeData={routeData} schedules={schedules} proposedSchedules={proposedSchedules} />
    </div>
  );
};

export default App;
