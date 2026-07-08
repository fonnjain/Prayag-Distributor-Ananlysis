import ExcelJS from "exceljs";
function cv(v){if(v&&typeof v==="object"){if("result"in v)return v.result;if("text"in v)return v.text;if("richText"in v)return v.richText.map(r=>r.text).join("");}return v;}
const wb = new ExcelJS.stream.xlsx.WorkbookReader(process.argv[2],{entries:"emit",sharedStrings:"cache",styles:"ignore",hyperlinks:"ignore",worksheets:"emit"});
for await (const ws of wb) {
  let n=0;
  for await (const row of ws) {
    n++;
    if (row.number === 3 || row.number === 4) console.log("r"+row.number+" FULL:", JSON.stringify((row.values||[]).map(cv)));
    if (row.number > 4) break;
  }
  break;
}
