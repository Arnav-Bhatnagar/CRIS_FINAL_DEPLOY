import React, { useState, useEffect, useId } from "react";

function columnLetter(index) {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

export default function FileUploadCard({ title, hint, formatLabel, layoutColumns, layoutRows, onUpload }) {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showFormat, setShowFormat] = useState(false);
  const inputId = useId();

  useEffect(() => {
    if (!showFormat) return;
    const handleKey = (e) => {
      if (e.key === "Escape") setShowFormat(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [showFormat]);

  const handleUpload = async () => {
    if (!file) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await onUpload(file);
      setStatus({ ok: true, msg: result?.message || "Uploaded" });
    } catch (err) {
      setStatus({ ok: false, msg: err?.message || "Something went wrong reading that file. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="upload-bar-item" title={hint}>
      <div className="upload-bar-row-top">
        <span className="upload-bar-label">{title}</span>
        <button
          type="button"
          className="upload-bar-format-btn"
          aria-label={`Accepted file format for ${title}`}
          onClick={() => setShowFormat(true)}
        >
          &#9432; Format
        </button>
      </div>

      <div className="upload-bar-row-bottom">
        <input
          id={inputId}
          type="file"
          className="upload-bar-input-native"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <label htmlFor={inputId} className="upload-bar-file-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M17 8l-5-5-5 5" />
            <path d="M12 3v12" />
          </svg>
          Choose File
        </label>
        <span className="upload-bar-filename" title={file?.name || "No file chosen"}>
          {file?.name || "No file chosen"}
        </span>
        <button className="btn primary upload-bar-btn" onClick={handleUpload} disabled={!file || busy}>
          {busy ? "…" : "Upload"}
        </button>

        {status && (
          <span className={`upload-bar-status ${status.ok ? "ok" : "err"}`} title={status.msg}>
            {status.ok ? "✓" : "✕"}
          </span>
        )}
      </div>


      {showFormat && (
        <div className="xlsx-modal-backdrop" onClick={() => setShowFormat(false)}>
          <div className="xlsx-modal" onClick={(e) => e.stopPropagation()}>
            <div className="xlsx-modal-titlebar">
              <span className="xlsx-modal-titlebar-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <rect width="24" height="24" rx="3" fill="#ffffff" />
                  <text x="12" y="17" textAnchor="middle" fontSize="14" fontWeight="700" fontFamily="Arial, Helvetica, sans-serif" fill="#107C41">X</text>
                </svg>
              </span>
              <span className="xlsx-modal-titlebar-title">{title} &mdash; expected file layout</span>
              <button type="button" className="xlsx-modal-close" onClick={() => setShowFormat(false)} aria-label="Close">
                &times;
              </button>
            </div>
            <div className="xlsx-modal-subbar">{formatLabel || "CSV or Excel (.csv, .xlsx, .xls)"}</div>
            <div className="xlsx-modal-gridwrap">
              <table className="xlsx-grid">
                <thead>
                  <tr>
                    <th className="xlsx-corner" />
                    {layoutColumns.map((_, i) => (
                      <th key={i} className="xlsx-colhead">{columnLetter(i)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th className="xlsx-rowhead">1</th>
                    {layoutColumns.map((c) => (
                      <td key={c} className="xlsx-headercell">{c}</td>
                    ))}
                  </tr>
                  {layoutRows.map((row, r) => (
                    <tr key={r}>
                      <th className="xlsx-rowhead">{r + 2}</th>
                      {layoutColumns.map((c) => (
                        <td key={c} className="xlsx-cell">{row[c]}</td>
                      ))}
                    </tr>
                  ))}
                  {Array.from({ length: 4 }).map((_, i) => (
                    <tr key={`blank-${i}`}>
                      <th className="xlsx-rowhead">{layoutRows.length + 2 + i}</th>
                      {layoutColumns.map((c) => (
                        <td key={c} className="xlsx-cell xlsx-cell-blank" />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
