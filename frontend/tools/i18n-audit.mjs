// Checks the translation catalogues against the code. Run: node tools/i18n-audit.mjs
//
// Three things go wrong with catalogues over time, and this reports all of
// them. A string added to a screen and never translated (it will render in
// English, which is survivable but should be a deliberate choice). A
// catalogue entry whose English wording has since been edited in the source
// — the translation is then dead weight and the screen has quietly reverted
// to English, which is the failure nobody notices. And a language having
// entries another language lacks.
//
// Exits non-zero only on orphans, since those always mean something broke;
// missing entries are reported but tolerated, because English is a valid
// thing for an untranslated string to render as.
import { readFileSync, globSync } from 'node:fs';

const LANGS = ['fr', 'zh'];

function keysInSource() {
  const keys = new Set();
  for (const f of globSync('src/**/*.{jsx,js}')) {
    if (f.startsWith('src/locales/')) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      keys.add(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r'));
    }
  }
  return keys;
}

function keysInCatalogue(lang) {
  const src = readFileSync(`src/locales/${lang}.js`, 'utf8');
  const body = src.slice(src.indexOf('export default {') + 'export default {'.length, src.lastIndexOf('};'));
  const keys = new Set();
  for (const m of body.matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)) keys.add(JSON.parse(m[1]));
  return keys;
}

// A file that calls tr() without importing it builds perfectly and then
// throws the moment that screen renders — a free identifier is not a build
// error. This is the check that would have caught exactly that, so it runs
// first and is fatal.
function filesMissingTrImport() {
  const bad = [];
  for (const f of globSync('src/**/*.{jsx,js}')) {
    if (f.startsWith('src/locales/') || f.endsWith('src/lib/i18n.jsx')) continue;
    const src = readFileSync(f, 'utf8');
    if (!/\btr\(/.test(src)) continue;
    if (!/import\s*\{[^}]*\btr\b[^}]*\}\s*from\s*'[^']*i18n\.jsx'/.test(src)) bad.push(f);
  }
  return bad;
}

const noImport = filesMissingTrImport();
if (noImport.length) {
  console.log(`${noImport.length} file(s) call tr() without importing it — these throw when the screen renders:`);
  noImport.forEach((f) => console.log('    ' + f));
  process.exit(1);
}

const source = keysInSource();
let orphaned = 0;
console.log(`${source.size} translatable strings in the interface.\n`);

const per = {};
for (const lang of LANGS) {
  const cat = keysInCatalogue(lang);
  per[lang] = cat;
  const missing = [...source].filter((k) => !cat.has(k));
  const orphans = [...cat].filter((k) => !source.has(k));
  orphaned += orphans.length;
  const pct = source.size ? Math.round(((source.size - missing.length) / source.size) * 100) : 100;
  console.log(`${lang}: ${cat.size} entries, ${pct}% covered, ${missing.length} untranslated, ${orphans.length} orphaned`);
  orphans.slice(0, 10).forEach((k) => console.log(`    orphan: ${JSON.stringify(k)}`));
  if (process.env.SHOW_MISSING) missing.slice(0, 40).forEach((k) => console.log(`    missing: ${JSON.stringify(k)}`));
}

const onlyFr = [...per.fr].filter((k) => !per.zh.has(k));
const onlyZh = [...per.zh].filter((k) => !per.fr.has(k));
if (onlyFr.length || onlyZh.length) {
  console.log(`\nLanguages disagree: ${onlyFr.length} only in fr, ${onlyZh.length} only in zh.`);
  onlyFr.slice(0, 5).forEach((k) => console.log(`    fr only: ${JSON.stringify(k)}`));
  onlyZh.slice(0, 5).forEach((k) => console.log(`    zh only: ${JSON.stringify(k)}`));
}

if (orphaned) { console.log(`\n${orphaned} orphaned entries — their English wording changed in the source.`); process.exit(1); }
