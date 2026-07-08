import { ReplitConnectors } from "@replit/connectors-sdk";
const c = new ReplitConnectors();
const id = "1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs";
for (const p of [
  `/v4/spreadsheets/${id}?fields=sheets.properties.title`,
  `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`,
]) {
  try {
    const r = await c.proxy("google-drive", p, { method: "GET" });
    const t = await r.text();
    console.log(p.slice(0, 60), "->", r.status, t.slice(0, 200).replace(/\n/g, " "));
  } catch (e) { console.log(p.slice(0, 60), "ERR", e.message.slice(0, 150)); }
}
