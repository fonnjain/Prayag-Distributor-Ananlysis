import ExcelJS from "exceljs";
function norm(s){return String(s??"").toUpperCase().replace(/[^A-Z0-9]/g,"");}
function cv(v){if(v&&typeof v==="object"){if("result"in v)return v.result;if("text"in v)return v.text;if("richText"in v)return v.richText.map(r=>r.text).join("");}return v;}

const file = process.argv[2];
console.log("=== " + file);
const wb = new ExcelJS.stream.xlsx.WorkbookReader(file,{entries:"emit",sharedStrings:"cache",styles:"ignore",hyperlinks:"ignore",worksheets:"emit"});
let sheetNo = 0;
for await (const ws of wb) {
  sheetNo++;
  if (sheetNo > 1) { console.log("  (additional sheet present: "+ws.name+")"); continue; }
  let headerIdx=-1, header=null, fyCol=-1, amtCol=-1;
  const fyCounts={}; let emptyFyWithAmount=0, emptyFyEmpty=0; let emptyFySample=null;
  let n=0;
  for await (const row of ws) {
    const vals=(row.values||[]).map(cv);
    if(headerIdx===-1){
      const set=vals.map(norm);
      if(set.some(v=>v==="CODE"||v==="ITEMCODE")&&set.some(v=>v==="QTY"||v==="QUANTITY")&&set.some(v=>v==="AMOUNT")){
        headerIdx=row.number; header=vals;
        fyCol=vals.findIndex(v=>{const s=String(v??"").trim().toUpperCase();return s==="FY YEAR"||/^FY[- ]?\d{4}-\d{2}$/.test(s);});
        amtCol=vals.findIndex(v=>norm(v)==="AMOUNT");
        continue;
      }
      if(row.number>20){console.log("  NO HEADER in 20 rows; sample:",JSON.stringify(vals.slice(0,16)));break;}
      console.log("  pre-header r"+row.number+":",JSON.stringify(vals.slice(0,16)));
      continue;
    }
    n++;
    const fy=String(vals[fyCol]??"").trim();
    if(fy===""){
      const amt=vals[amtCol];
      const hasAny=vals.some(v=>v!=null&&String(v).trim()!=="");
      if(amt!=null&&String(amt).trim()!==""){emptyFyWithAmount++;if(!emptyFySample)emptyFySample=vals.slice(0,16);}
      else if(!hasAny)emptyFyEmpty++;
      else {fyCounts["<partial>"]=(fyCounts["<partial>"]||0)+1;if(!emptyFySample)emptyFySample=vals.slice(0,16);}
    } else fyCounts[fy]=(fyCounts[fy]||0)+1;
  }
  console.log("  header r"+headerIdx+":",JSON.stringify(header));
  console.log("  fyCol:",fyCol,"amtCol:",amtCol,"dataRows:",n);
  console.log("  fyCounts:",JSON.stringify(fyCounts));
  console.log("  emptyFY withAmount:",emptyFyWithAmount,"| fully empty:",emptyFyEmpty);
  if(emptyFySample)console.log("  emptyFY/partial sample:",JSON.stringify(emptyFySample));
  console.log("  memMB:",Math.round(process.memoryUsage().rss/1e6));
}
