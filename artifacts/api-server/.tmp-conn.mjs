import { ReplitConnectors } from "@replit/connectors-sdk";
const c = new ReplitConnectors();
const conns = await c.listConnections({ connector_names: "google-drive" });
console.log("count:", conns.length);
if (conns.length) {
  const conn = conns[0];
  console.log("keys:", Object.keys(conn));
  const settings = conn.settings;
  if (settings) console.log("settings keys:", Object.keys(settings), "| has access_token:", !!settings.access_token, "| token length:", settings.access_token?.length ?? 0);
  // test a direct Sheets API call without printing the token
  const token = settings?.access_token ?? settings?.oauth?.credentials?.access_token;
  console.log("resolved token:", token ? "YES (len " + token.length + ")" : "NO");
  if (token) {
    const r = await fetch("https://sheets.googleapis.com/v4/spreadsheets/1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs?fields=sheets.properties(title,gridProperties(rowCount,columnCount))", { headers: { Authorization: "Bearer " + token } });
    console.log("sheets api via runtime token:", r.status);
    if (r.ok) { const j = await r.json(); console.log(JSON.stringify(j.sheets?.map(s=>s.properties))); }
    else console.log((await r.text()).slice(0,300));
  }
}
