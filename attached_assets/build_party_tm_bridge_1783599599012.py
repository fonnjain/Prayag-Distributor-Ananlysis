#!/usr/bin/env python3
"""
build_party_tm_bridge.py
------------------------
Builds the Party -> Team Member bridge for the Prayag management report by reading every
per-member working file in the "STATE HEAD (Team Member Report)" folder tree.

Each member file has two relevant tabs:
  - "Distributor Visit Report 26-27"  -> DIST# rows  (bridges the SALE register; register Customer = distributor)
  - "Retailer Report 26-27"           -> RET#  rows  (bridges Secondary Order Booking; validates order side)
Both tabs embed, in their top rows: Team Member Name and Reporting Manager (= State Head).

Output: party_tm_bridge.csv with columns
  Party Type | Party ID | Party Name | Team Member | State Head | Channel Type | Source File

USAGE
  pip install google-api-python-client google-auth
  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service_account.json   # must have Drive+Sheets read
  python build_party_tm_bridge.py --root-folder 1-guQptN9S4NrW024jGizKo0V4nFDtHMv --out party_tm_bridge.csv

Notes
  - Reads via the Sheets API values.get (no 10 MB export cap).
  - Skips the register/summary workbooks; only processes files that HAVE a "Distributor Visit Report"
    or "Retailer Report" tab (that is what identifies a per-member file).
  - Header rows drift; detection is by content, tolerant of the "26-27" suffix on tab names.
"""
import argparse, csv, re, sys, time
from google.oauth2 import service_account
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/spreadsheets.readonly"]

def clients():
    creds = service_account.Credentials.from_service_account_file(
        __import__("os").environ["GOOGLE_APPLICATION_CREDENTIALS"], scopes=SCOPES)
    return build("drive", "v3", credentials=creds), build("sheets", "v4", credentials=creds)

def list_spreadsheets(drive, folder_id):
    """Recurse the folder tree, yield (id, name) for every Google Sheet."""
    stack, seen = [folder_id], set()
    while stack:
        fid = stack.pop()
        if fid in seen: continue
        seen.add(fid)
        page = None
        while True:
            resp = drive.files().list(
                q=f"'{fid}' in parents and trashed=false",
                fields="nextPageToken, files(id,name,mimeType)",
                pageSize=1000, pageToken=page,
                supportsAllDrives=True, includeItemsFromAllDrives=True).execute()
            for f in resp.get("files", []):
                if f["mimeType"] == "application/vnd.google-apps.folder":
                    stack.append(f["id"])
                elif f["mimeType"] == "application/vnd.google-apps.spreadsheet":
                    yield f["id"], f["name"]
            page = resp.get("nextPageToken")
            if not page: break

def tabs(sheets, sid):
    meta = sheets.spreadsheets().get(spreadsheetId=sid, fields="sheets.properties.title").execute()
    return [s["properties"]["title"] for s in meta.get("sheets", [])]

def read_tab(sheets, sid, title):
    r = sheets.spreadsheets().values().get(
        spreadsheetId=sid, range=f"'{title}'",
        valueRenderOption="UNFORMATTED_VALUE", dateTimeRenderOption="FORMATTED_STRING").execute()
    return r.get("values", [])

def norm(s): return re.sub(r"[^a-z0-9]", "", str(s).lower())

def meta_from_header(rows):
    """Pull Team Member Name + Reporting Manager from the top band (first ~4 rows)."""
    tm = sh = None
    flat = []
    for r in rows[:4]:
        flat += [str(c) for c in r]
    for i, c in enumerate(flat):
        n = norm(c)
        if n in ("teammembername", "name") and i + 1 < len(flat) and not tm:
            tm = flat[i + 1].strip()
        if n == "reportingmanager" and i + 1 < len(flat) and not sh:
            sh = flat[i + 1].strip()
    return tm, sh

def find_header_row(rows, id_key):
    for i, r in enumerate(rows[:12]):
        cells = [norm(c) for c in r]
        if any(id_key in c for c in cells) and any("name" in c for c in cells):
            return i
    return -1

def extract_party_tab(rows, party_type, id_key):
    tm, sh = meta_from_header(rows)
    hi = find_header_row(rows, id_key)
    if hi < 0: return tm, sh, []
    hdr = [norm(c) for c in rows[hi]]
    def col(*keys):
        for k in keys:
            for j, h in enumerate(hdr):
                if h == k or h.startswith(k): return j
        return -1
    c_id = col("id", "retailerid", "distributorid")
    c_nm = col("name", "retailername", "distributorname")
    c_ty = col("type")
    out = []
    for r in rows[hi + 1:]:
        if not r: continue
        pid = str(r[c_id]).strip() if c_id >= 0 and c_id < len(r) else ""
        nm  = str(r[c_nm]).strip() if c_nm >= 0 and c_nm < len(r) else ""
        if not pid or pid in ("--", "TOTAL"): continue
        ch  = str(r[c_ty]).strip() if c_ty >= 0 and c_ty < len(r) else party_type.title()
        out.append((party_type, pid, nm, ch))
    return tm, sh, out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root-folder", required=True,
                    help="Drive folder id of 'STATE HEAD (Team Member Report)' (default: 1-guQptN9S4NrW024jGizKo0V4nFDtHMv)")
    ap.add_argument("--out", default="party_tm_bridge.csv")
    args = ap.parse_args()
    drive, sheets = clients()

    rows_out, files_seen, files_used, unmatched = [], 0, 0, []
    for sid, name in list_spreadsheets(drive, args.root_folder):
        files_seen += 1
        try:
            titles = tabs(sheets, sid)
        except Exception as e:
            print(f"  skip {name}: {e}", file=sys.stderr); continue
        dist_tab = next((t for t in titles if norm(t).startswith("distributorvisitreport")), None)
        ret_tab  = next((t for t in titles if norm(t).startswith("retailerreport")), None)
        if not dist_tab and not ret_tab:
            continue  # not a per-member file
        files_used += 1
        member_seen = False
        for tab, ptype, idkey in [(dist_tab, "DISTRIBUTOR", "id"), (ret_tab, "RETAILER", "retailerid")]:
            if not tab: continue
            try:
                data = read_tab(sheets, sid, tab)
            except Exception as e:
                print(f"  read fail {name}/{tab}: {e}", file=sys.stderr); continue
            tm, sh, parties = extract_party_tab(data, ptype, "id" if ptype == "DISTRIBUTOR" else "retailerid")
            if tm: member_seen = True
            for (pt, pid, pnm, ch) in parties:
                rows_out.append([pt, pid, pnm, tm or name, sh or "", ch, name])
        if not member_seen:
            unmatched.append(name)
        time.sleep(0.05)  # gentle on quota

    # de-dup on (Party ID, Team Member)
    seen, dedup = set(), []
    for r in rows_out:
        k = (r[1], r[3])
        if k in seen: continue
        seen.add(k); dedup.append(r)

    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Party Type", "Party ID", "Party Name", "Team Member", "State Head", "Channel Type", "Source File"])
        w.writerows(dedup)

    dcount = sum(1 for r in dedup if r[0] == "DISTRIBUTOR")
    rcount = sum(1 for r in dedup if r[0] == "RETAILER")
    print(f"Files scanned: {files_seen} | per-member files used: {files_used}")
    print(f"Bridge rows: {len(dedup)}  ({dcount} distributor, {rcount} retailer)")
    print(f"Distinct members: {len(set(r[3] for r in dedup))} | Distinct state heads: {len(set(r[4] for r in dedup if r[4]))}")
    if unmatched:
        print(f"Files with a party tab but no Team Member header ({len(unmatched)}): {unmatched[:8]}...")
    print(f"Wrote {args.out}")

if __name__ == "__main__":
    main()
