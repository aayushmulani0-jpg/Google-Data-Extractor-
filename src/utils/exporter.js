/**
 * Escape a cell value for CSV (handles quotes, commas, newlines).
 */
function escapeCell(value) {
  const str = String(value ?? "");
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from headers array and rows (array of arrays).
 */
export function buildCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(","));
  }
  return lines.join("\n");
}

/**
 * Trigger a browser download of the given CSV content.
 */
export function downloadCsv(filename, csvContent) {
  const bom = "\uFEFF"; // UTF-8 BOM for Excel compatibility
  const blob = new Blob([bom + csvContent], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Build and download a CSV from headers + rows.
 */
export function exportRowsAsCsv(filename, headers, rows) {
  const csv = buildCsv(headers, rows);
  downloadCsv(filename, csv);
}
