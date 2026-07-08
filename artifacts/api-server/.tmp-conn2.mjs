import { ReplitConnectors } from "@replit/connectors-sdk";
const c = new ReplitConnectors();
// try expand variants
for (const expand of [["settings"], ["credentials"], ["settings","connector"]]) {
  try {
    const conns = await c.listConnections({ connector_names: "google-drive", expand });
    const conn = conns[0];
    const s = conn?.settings;
    console.log("expand", JSON.stringify(expand), "-> settings:", s ? Object.keys(s) : "none");
    if (s?.access_token) { console.log("HAS access_token, len", s.access_token.length); break; }
    if (s?.oauth) console.log("oauth keys:", Object.keys(s.oauth));
  } catch (e) { console.log("expand", JSON.stringify(expand), "error:", e.message.slice(0,120)); }
}
console.log("proxyUrl:", c.getProxyUrl());
try { const h = await c.getProxyHeaders("google-drive"); console.log("proxy header names:", Object.keys(h)); } catch(e){ console.log("hdr err", e.message.slice(0,120)); }
