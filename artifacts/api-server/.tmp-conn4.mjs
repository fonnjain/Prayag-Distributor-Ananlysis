const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
const token = process.env.REPL_IDENTITY
  ? "repl " + process.env.REPL_IDENTITY
  : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;
console.log("hostname:", hostname, "| identity token:", token ? "present" : "MISSING");
const r = await fetch(`https://${hostname}/api/v2/connection?include_secrets=true&connector_names=google-drive`, {
  headers: { Accept: "application/json", X_REPLIT_TOKEN: token },
});
console.log("status:", r.status);
const j = await r.json();
const item = j.items?.[0];
if (item) {
  const s = item.settings ?? {};
  console.log("settings keys:", Object.keys(s));
  const at = s.access_token ?? s.oauth?.credentials?.access_token;
  console.log("access_token:", at ? "YES len " + at.length : "NO");
  console.log("expires_at:", s.expires_at ?? s.oauth?.credentials?.expires_at ?? "n/a");
  if (at) {
    const r2 = await fetch("https://sheets.googleapis.com/v4/spreadsheets/1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs?fields=sheets.properties(title,gridProperties(rowCount,columnCount))", { headers: { Authorization: "Bearer " + at } });
    console.log("sheets api:", r2.status);
    if (r2.ok) { const j2 = await r2.json(); console.log(JSON.stringify(j2.sheets?.map(x=>x.properties))); }
  }
}
