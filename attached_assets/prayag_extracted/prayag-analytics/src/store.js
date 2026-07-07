// src/store.js — tiny JSON persistence under ./data.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const p = (name) => path.join(DIR, `${name}.json`);
function save(name, obj) { fs.writeFileSync(p(name), JSON.stringify(obj, null, 2)); }
function load(name) { try { return JSON.parse(fs.readFileSync(p(name), 'utf8')); } catch { return null; } }
function exists(name) { return fs.existsSync(p(name)); }

module.exports = { save, load, exists };
