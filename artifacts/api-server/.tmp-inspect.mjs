import ExcelJS from "exceljs";

const files = process.argv.slice(2);

function norm(s) {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function cellVal(v) {
  if (v && typeof v === "object") {
    if ("result" in v) return v.result;
    if ("text" in v) return v.text;
    if ("richText" in v) return v.richText.map(r => r.text).join("");
  }
  return v;
}

for (const file of files) {
  console.log("=== " + file);
  const wb = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    entries: "emit", sharedStrings: "cache", styles: "ignore",
    hyperlinks: "ignore", worksheets: "emit",
  });
  for await (const ws of wb) {
    let headerRow = null, headerIdx = -1, fyCol = -1;
    let rowCount = 0, scanned = [];
    const fyCounts = {};
    for await (const row of ws) {
      const vals = (row.values || []).map(cellVal);
      if (headerIdx === -1) {
        scanned.push({ n: row.number, vals });
        const set = vals.map(norm);
        const hasCode = set.some(v => v === "CODE" || v === "ITEMCODE");
        const hasQty = set.some(v => v === "QTY" || v === "QUANTITY");
        const hasAmt = set.some(v => v === "AMOUNT");
        if (hasCode && hasQty && hasAmt) {
          headerIdx = row.number;
          headerRow = vals;
          // FY col: header "FY YEAR" or header text matching FY-\d{4}-\d{2}
          fyCol = vals.findIndex(v => {
            const s = String(v ?? "").trim().toUpperCase();
            return s === "FY YEAR" || /^FY[- ]?\d{4}-\d{2}$/.test(s);
          });
          continue;
        }
        if (row.number > 20) { console.log("  NO HEADER FOUND in first 20 rows"); break; }
        continue;
      }
      rowCount++;
      if (fyCol >= 0) {
        const fy = String(vals[fyCol] ?? "").trim();
        fyCounts[fy] = (fyCounts[fy] || 0) + 1;
      }
      if (rowCount <= 2) console.log("  sample row:", JSON.stringify(vals.slice(0, 20)));
    }
    console.log("  sheet:", ws.name, "| headerRowNum:", headerIdx, "| dataRows:", rowCount);
    if (headerIdx === -1) {
      for (const s of scanned.slice(0, 6)) console.log("  scan r" + s.n + ":", JSON.stringify(s.vals.slice(0, 12)));
    } else {
      console.log("  headers:", JSON.stringify(headerRow));
      console.log("  fyColIdx:", fyCol, "| fyCounts:", JSON.stringify(fyCounts));
    }
    console.log("  memMB:", Math.round(process.memoryUsage().rss / 1e6));
    break; // first worksheet only for now
  }
}
