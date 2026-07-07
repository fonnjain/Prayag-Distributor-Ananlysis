// src/drive.js — Google Sheets access via a server-side service account.
// Uses spreadsheets.values.get (no 10 MB export cap) and spreadsheets.get for tab discovery.
const { google } = require('googleapis');

let _client = null;

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set (see .env.example / SETUP_DRIVE.md).');
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file as one line.'); }
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function sheets() {
  if (_client) return _client;
  const authClient = await getAuth().getClient();
  _client = google.sheets({ version: 'v4', auth: authClient });
  return _client;
}

async function driveConfigured() {
  try { await sheets(); return true; } catch { return false; }
}

// List tab titles for a spreadsheet.
async function listTabs(spreadsheetId) {
  const s = await sheets();
  const r = await s.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  return (r.data.sheets || []).map((x) => x.properties.title);
}

// Read all values from a tab (used range). Dates come back as formatted strings.
async function readTab(spreadsheetId, tab) {
  const s = await sheets();
  const r = await s.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return r.data.values || [];
}

module.exports = { sheets, driveConfigured, listTabs, readTab };
