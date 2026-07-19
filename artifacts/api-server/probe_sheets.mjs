import { readTabRowsChunked } from './dist/lib/registers/sheetsApi.js';

const sheets = [
  { label: 'FY2021-22 DataSheet', sheetId: '1RtRByRmNQorYOEeHsZuOy1GIkB7dVu7MNv9P_pg97Bs', tab: 'Data Sheet' },
  { label: 'FY2021-22 June',      sheetId: '1RtRByRmNQorYOEeHsZuOy1GIkB7dVu7MNv9P_pg97Bs', tab: 'June' },
  { label: 'FY2022-23 DataSheet', sheetId: '1wj96uhny-eBC2umGa8bP9M1j1T9YEt-DsThduzoC-2c', tab: 'Data Sheet' },
  { label: 'FY2022-23 June',      sheetId: '1wj96uhny-eBC2umGa8bP9M1j1T9YEt-DsThduzoC-2c', tab: 'June' },
];

for (const s of sheets) {
  const all = [];
  await readTabRowsChunked(s.sheetId, s.tab, (chunk) => { for (const r of chunk) all.push(r); });
  const header = all[0]?.map(c => c == null ? '' : String(c)).join(' | ');
  const last5  = all.slice(-5).map((r,i) => `[${all.length-5+i}] ` + r.map(c => c==null?'':String(c)).join(' | '));
  console.log(`\n=== ${s.label}  rows=${all.length} ===`);
  console.log('HDR: ' + header);
  last5.forEach(r => console.log(r));
}
