import * as XLSX from "xlsx";

// Reads CSV/XLSX uploads in the browser and normalises them so the app can
// find columns by alias instead of by exact header name.
//
// Safety caps so a huge or corrupt upload cannot freeze the tab.
export const MAX_ROWS = 50000;

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Skips title/spacer rows above the real header: the header is the first
// of the first few rows that has at least two non-empty cells.
const MAX_HEADER_SCAN_ROWS = 10;
function findHeaderRowIndex(sheet) {
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  for (let i = 0; i < Math.min(grid.length, MAX_HEADER_SCAN_ROWS); i++) {
    const nonEmptyCells = grid[i].filter((c) => String(c).trim() !== "").length;
    if (nonEmptyCells >= 2) return i;
  }
  return 0;
}

// "Cumulative_Distance" and "cumulative distance" both become "cumulativedistance".
function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MAX_SHEETS_SCANNED = 25;

// Returns { rows, truncated, totalRows, sheetName, sheetCount }.
// When the workbook has several sheets, `chooseSheet(rows)` scores each one
// and the highest-scoring sheet is used.
export async function readSpreadsheet(file, { chooseSheet } = {}) {
  if (!file) {
    throw new Error("No file selected.");
  }
  if (file.size === 0) {
    throw new Error("That file is empty (0 bytes).");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB, which is larger than the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit. Please split it into smaller files or trim unused columns/sheets.`
    );
  }

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error("Couldn't read that file from disk. Please try uploading it again.");
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "array" });
  } catch {
    throw new Error("Couldn't parse that file. Make sure it's a valid, non-corrupted CSV or Excel (.xlsx/.xls) file.");
  }

  const sheetNames = (workbook.SheetNames || []).filter((n) => workbook.Sheets[n]);
  if (sheetNames.length === 0) {
    throw new Error("That workbook doesn't contain any readable sheets.");
  }

  const candidates = [];
  for (const name of sheetNames.slice(0, MAX_SHEETS_SCANNED)) {
    const sheet = workbook.Sheets[name];
    const headerRow = findHeaderRowIndex(sheet);
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: "", range: headerRow, blankrows: false });
    if (raw.length === 0) continue;
    const rows = raw.map((row) => {
      const normalized = {};
      Object.entries(row).forEach(([key, value]) => {
        normalized[normalizeKey(key)] = value;
      });
      return normalized;
    });
    candidates.push({ name, rows, totalRows: raw.length });
  }

  if (candidates.length === 0) {
    throw new Error(`This workbook's sheet(s) have a header row but no data rows.`);
  }

  let chosen = candidates[0];
  if (chooseSheet && candidates.length > 1) {
    let bestScore = chooseSheet(chosen.rows) || 0;
    for (const c of candidates.slice(1)) {
      const score = chooseSheet(c.rows) || 0;
      if (score > bestScore) { bestScore = score; chosen = c; }
    }
  }

  const truncated = chosen.totalRows > MAX_ROWS;
  const rows = truncated ? chosen.rows.slice(0, MAX_ROWS) : chosen.rows;

  return { rows, truncated, totalRows: chosen.totalRows, sheetName: chosen.name, sheetCount: sheetNames.length };
}

// Accepts numbers or strings such as "1,234.5 km"; returns NaN if unusable.
export function parseDistance(raw) {
  if (raw === undefined || raw === null || raw === "") return NaN;
  if (typeof raw === "number") return raw;
  const cleaned = String(raw).replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return NaN;
  return Number(cleaned);
}

function isBlankCell(v) {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}
function cleanCell(v) {
  return typeof v === "string" ? v.trim() : v;
}

// Returns the first non-blank value whose normalised header matches one of
// `aliases` (exact match first, then partial match in either direction).
export function pick(row, aliases) {
  for (const alias of aliases) {
    if (!isBlankCell(row[alias])) return cleanCell(row[alias]);
  }
  for (const alias of aliases) {
    const key = Object.keys(row).find(
      (k) => !isBlankCell(row[k]) && k.length >= 3 && (k.includes(alias) || alias.includes(k))
    );
    if (key) return cleanCell(row[key]);
  }
  return undefined;
}

// Converts "HH:MM[:SS]" (optionally with am/pm) to minutes. A plain number
// is treated as seconds, which is how the schedule exports store times.
export function parseTimeToMinutes(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string" && raw.includes(":")) {
    const trimmed = raw.trim();
    const ampmMatch = trimmed.match(/\s*(am|pm)\s*$/i);
    const timePart = ampmMatch ? trimmed.slice(0, ampmMatch.index) : trimmed;
    const [hRaw, mRaw, sRaw] = timePart.split(":");
    let h = Number(hRaw);
    const m = Number(mRaw);
    const s = Number(sRaw);
    if (Number.isNaN(h)) return null;
    if (ampmMatch) {
      const isPM = ampmMatch[1].toLowerCase() === "pm";
      h = h % 12;
      if (isPM) h += 12;
    }
    return h * 60 + (Number.isNaN(m) ? 0 : m) + (Number.isNaN(s) ? 0 : s / 60);
  }
  const num = Number(raw);
  if (Number.isNaN(num)) return null;
  return num / 60;
}
