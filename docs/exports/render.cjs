// Render docs/exports/*.md into PDFs + architecture Excel.
// Run from artifacts/api-server so pdfkit/exceljs resolve.
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");

const DIR = "/home/runner/workspace/docs/exports";

// ── minimal markdown → pdfkit renderer ──────────────────────────────────────
function stripInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1").replace(/\*(.+?)\*/g, "$1")
    .replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/₹/g, "Rs ").replace(/[—–]/g, "-")
    .replace(/×/g, "x").replace(/÷/g, "/").replace(/⊂/g, " is a subset of ").replace(/Σ/g, "Sum")
    .replace(/’/g, "'").replace(/[“”]/g, '"').replace(/→/g, "->").replace(/·/g, "-");
}
function renderPdf(mdPath, pdfPath, title) {
  const md = fs.readFileSync(mdPath, "utf8");
  const doc = new PDFDocument({ margin: 54, size: "A4" });
  doc.pipe(fs.createWriteStream(pdfPath));
  doc.fontSize(20).font("Helvetica-Bold").text(title);
  doc.moveDown(0.3);
  doc.fontSize(9).font("Helvetica").fillColor("#666")
    .text("Prayag India Sales Intelligence — glossary, calculations & logic · generated " + new Date().toISOString().slice(0, 10));
  doc.fillColor("black").moveDown(1);

  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    // table block
    if (/^\s*\|/.test(line)) {
      const tbl = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tbl.push(lines[i]); i++; }
      const rows = tbl
        .filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r))
        .map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => stripInline(c.trim())));
      for (let r = 0; r < rows.length; r++) {
        const isHead = r === 0;
        doc.fontSize(8.5).font(isHead ? "Helvetica-Bold" : "Helvetica")
          .text(rows[r].join("  •  "), { indent: 10 });
        if (isHead) doc.moveDown(0.15);
      }
      doc.moveDown(0.6);
      continue;
    }
    i++;
    if (!line.trim()) { doc.moveDown(0.35); continue; }
    let m;
    if ((m = line.match(/^#{1,2}\s+(.*)/))) {
      doc.moveDown(0.5);
      doc.fontSize(15).font("Helvetica-Bold").fillColor("#1a3a6b").text(stripInline(m[1]));
      doc.fillColor("black").moveDown(0.3);
    } else if ((m = line.match(/^###\s+(.*)/))) {
      doc.moveDown(0.35);
      doc.fontSize(12).font("Helvetica-Bold").text(stripInline(m[1]));
      doc.moveDown(0.2);
    } else if ((m = line.match(/^#{4,6}\s+(.*)/))) {
      doc.fontSize(10.5).font("Helvetica-Bold").text(stripInline(m[1]));
      doc.moveDown(0.15);
    } else if ((m = line.match(/^\s*([*-])\s+(.*)/))) {
      const indent = (raw.match(/^\s*/) || [""])[0].length >= 4 ? 30 : 14;
      doc.fontSize(10).font("Helvetica").text("• " + stripInline(m[2]), { indent, lineGap: 1.5 });
    } else if ((m = line.match(/^\s*(\d+)\.\s+(.*)/))) {
      doc.fontSize(10).font("Helvetica").text(m[1] + ". " + stripInline(m[2]), { indent: 14, lineGap: 1.5 });
    } else {
      doc.fontSize(10).font("Helvetica").text(stripInline(line), { lineGap: 1.5 });
    }
  }
  doc.end();
  console.log("PDF:", pdfPath);
}

// ── architecture markdown tables → Excel ────────────────────────────────────
async function renderExcel(mdPath, xlsxPath) {
  const md = fs.readFileSync(mdPath, "utf8");
  const wb = new ExcelJS.Workbook();
  // split by ## headings
  const sections = md.split(/^##\s+/m).filter((s) => s.trim());
  for (const sec of sections) {
    const lines = sec.split("\n");
    let name = lines[0].replace(/[\\/*?:[\]]/g, "").trim().slice(0, 31) || "Sheet";
    const ws = wb.addWorksheet(name);
    let tableRows = [];
    let notes = [];
    for (const l of lines.slice(1)) {
      if (/^\s*\|/.test(l)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue;
        tableRows.push(l.trim().replace(/^\||\|$/g, "").split("|").map((c) => stripInline(c.trim())));
      } else if (l.trim() && !/^#/.test(l.trim())) {
        notes.push(stripInline(l.trim()));
      }
    }
    if (tableRows.length) {
      const header = tableRows[0];
      ws.addRow(header);
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDE8F5" } };
      for (const r of tableRows.slice(1)) ws.addRow(r);
      header.forEach((h, idx) => {
        let max = h.length;
        for (const r of tableRows.slice(1)) max = Math.max(max, (r[idx] || "").length);
        ws.getColumn(idx + 1).width = Math.min(70, Math.max(12, max + 2));
        ws.getColumn(idx + 1).alignment = { wrapText: true, vertical: "top" };
      });
    }
    if (notes.length) {
      ws.addRow([]);
      for (const n of notes) ws.addRow([n]);
    }
  }
  await wb.xlsx.writeFile(xlsxPath);
  console.log("XLSX:", xlsxPath);
}

(async () => {
  renderPdf(path.join(DIR, "sales-deep-dive.md"), path.join(DIR, "Sales-Deep-Dive-Glossary-and-Logic.pdf"), "Sales Deep Dive — Glossary & Calculations");
  renderPdf(path.join(DIR, "distributor-deep-dive.md"), path.join(DIR, "Distributor-Deep-Dive-Glossary-and-Logic.pdf"), "Distributor Deep Dive — Glossary & Calculations");
  renderPdf(path.join(DIR, "sku-deep-dive.md"), path.join(DIR, "SKU-Deep-Dive-Glossary-and-Logic.pdf"), "SKU Deep Dive — Glossary & Calculations");
  renderPdf(path.join(DIR, "state-head-sales-people.md"), path.join(DIR, "State-Head-and-Sales-People-Glossary-and-Logic.pdf"), "State Head & Sales People — Glossary & Calculations");
  await renderExcel(path.join(DIR, "architecture-db.md"), path.join(DIR, "Architecture-and-Database.xlsx"));
})().catch((e) => { console.error(e); process.exit(1); });
