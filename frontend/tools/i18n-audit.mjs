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
// Before any of that it checks the two mistakes that build cleanly and
// still break the app (see the checks below), and it counts the text on
// screen that was never wrapped for translation at all.
//
// Exits non-zero on those two mistakes and on orphans, since those always
// mean something broke; missing entries are reported but tolerated,
// because English is a valid thing for an untranslated string to render as.
//
// SHOW_MISSING=1 lists untranslated keys; SHOW_UNWRAPPED=1 lists the
// on-screen text that isn't wrapped.
import { sourceFiles, parseFile, walk, collectKeys, loadCatalogue } from './i18n-source.mjs';

const LANGS = ['fr', 'zh'];

// Everything a screen might use to translate or to format for the reader's
// language, and the module that has to provide it.
const PROVIDERS = {
  tr: 'i18n.jsx', trNodes: 'i18n.jsx', docTr: 'i18n.jsx', msg: 'i18n.jsx',
  activeLocale: 'i18n.jsx', activeIntlLocale: 'i18n.jsx',
  DOCUMENT_LOCALE: 'i18n.jsx', DOCUMENT_INTL_LOCALE: 'i18n.jsx',
  formatDocDate: 'dates.js'
};

// Calls that read the language of the moment. At module level they run
// once, when the file is first loaded, and the result never changes again —
// a language switch remounts components, it does not reload modules. So a
// sidebar built with tr() at the top of a file stays in whatever language
// the app started in. docTr() is exempt: the documents' language is a
// constant, so evaluating it early changes nothing.
const READS_LOCALE = new Set(['tr', 'trNodes', 'activeLocale', 'activeIntlLocale']);

// Where on-screen text lives outside a JSX text node.
const DISPLAY_ATTRS = new Set(['placeholder', 'title', 'alt', 'aria-label', 'label']);

// Text that is the same in every language: names, the company's letterhead,
// and acronyms that are names in their own right (SSNIT and PAYE are
// Ghana's statutory deductions, not words to translate).
const SAME_IN_EVERY_LANGUAGE = new Set([
  'Bamboo OS', 'Bamboo Products', 'Bamboo Products Limited', 'CHOU AND ASSOCIATES', 'BPL', 'PROD',
  'Poki House', '35 J K Siaw St, Community 9, Tema, Ghana', 'GT-191-1859', 'GT-191-1859 (GhanaPostGPS)', '(GhanaPostGPS)', 'GhanaPost GPS',
  'Bambusa vulgaris', 'TR-001',
  'WhatsApp: 0591933925', 'www.bplghana.com', 'name@bplghana.com',
  'WhatsApp', 'TikTok', 'YouTube', 'Twitch', 'Facebook', 'Instagram', 'LinkedIn', 'Google', 'Square',
  'GHS', 'USD', 'EUR', 'PDF', 'CSV', 'PIN', 'OK', 'SKU', 'SWIFT', 'SSNIT', 'PAYE', 'kWh, m³'
]);

// Files whose English is deliberate. The thermal printer is sent Latin-1
// bytes, so anything but English prints as garbage; AuthContext's one
// message is a developer error that no user sees.
const ENGLISH_ON_PURPOSE = new Set(['src/lib/thermalPrinter.js', 'src/auth/AuthContext.jsx']);

// The string literals an expression can put on screen: {x || 'None'},
// {ok ? 'Yes' : 'No'}. Calls are not followed — a tr() inside is already
// translated, and anything else returns data.
function renderedLiterals(expr, out) {
  if (!expr) return out;
  if (expr.type === 'Literal' && typeof expr.value === 'string') out.push(expr);
  else if (expr.type === 'ConditionalExpression') { renderedLiterals(expr.consequent, out); renderedLiterals(expr.alternate, out); }
  else if (expr.type === 'LogicalExpression' || (expr.type === 'BinaryExpression' && expr.operator === '+')) { renderedLiterals(expr.left, out); renderedLiterals(expr.right, out); }
  return out;
}

function bindingNames(pattern, out) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') out.add(pattern.name);
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((p) => bindingNames(p.type === 'RestElement' ? p.argument : p.value, out));
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((e) => bindingNames(e, out));
  else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, out);
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument, out);
}

// An Identifier that names a variable, as opposed to a property name
// (obj.tr, { tr: 1 }) or the name side of an import/export.
function isReference(node, parent) {
  if (!parent) return true;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false;
  if (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return false;
  if ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed) return false;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier') return false;
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false;
  return true;
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'PropertyDefinition']);

const missingImports = [];
const moduleLevel = [];
const unwrapped = [];

for (const file of sourceFiles()) {
  const { code, ast } = parseFile(file);
  const lineOf = (node) => code.slice(0, node.start).split('\n').length;

  const bound = new Set();
  walk(ast, (node) => {
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') bound.add(node.local.name);
    if (node.type === 'VariableDeclarator') bindingNames(node.id, bound);
    if (node.type === 'FunctionDeclaration' && node.id) bound.add(node.id.name);
    if (FUNCTION_TYPES.has(node.type) && node.params) node.params.forEach((p) => bindingNames(p, bound));
  });

  const reported = new Set();
  walk(ast, (node, parents) => {
    const parent = parents[parents.length - 1];

    // A file that calls tr() without importing it builds perfectly and
    // then throws the moment that screen renders — a free identifier is
    // not a build error.
    if (node.type === 'Identifier' && PROVIDERS[node.name] && !bound.has(node.name) && isReference(node, parent) && !reported.has(node.name)) {
      reported.add(node.name);
      missingImports.push(`${file}:${lineOf(node)}  ${node.name} (from ${PROVIDERS[node.name]})`);
    }

    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && READS_LOCALE.has(node.callee.name) &&
        !parents.some((p) => FUNCTION_TYPES.has(p.type))) {
      moduleLevel.push(`${file}:${lineOf(node)}  ${code.slice(node.start, Math.min(node.end, node.start + 60))}`);
    }

    if (ENGLISH_ON_PURPOSE.has(file)) return;
    if (node.type === 'JSXText') {
      const text = node.value.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]{2}/.test(text) && !SAME_IN_EVERY_LANGUAGE.has(text)) unwrapped.push(`${file}:${lineOf(node)}  ${JSON.stringify(text)}`);
    }
    if (node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier' && DISPLAY_ATTRS.has(node.name.name) &&
        node.value && node.value.type === 'Literal' && typeof node.value.value === 'string') {
      const text = node.value.value.trim();
      if (/[A-Za-z]{2}/.test(text) && !SAME_IN_EVERY_LANGUAGE.has(text)) unwrapped.push(`${file}:${lineOf(node)}  ${node.name.name}=${JSON.stringify(text)}`);
    }
    const shown = node.type === 'JSXExpressionContainer' && parent &&
      (parent.type === 'JSXElement' || parent.type === 'JSXFragment' ||
       (parent.type === 'JSXAttribute' && parent.name.type === 'JSXIdentifier' && DISPLAY_ATTRS.has(parent.name.name)));
    if (shown) {
      for (const lit of renderedLiterals(node.expression, [])) {
        const text = lit.value.trim();
        if (/[A-Za-z]{2}/.test(text) && !SAME_IN_EVERY_LANGUAGE.has(text)) unwrapped.push(`${file}:${lineOf(lit)}  ${JSON.stringify(text)}`);
      }
    }
  });
}

let fatal = false;
if (missingImports.length) {
  fatal = true;
  console.log(`${missingImports.length} use(s) without an import — these throw when the screen renders:`);
  missingImports.forEach((l) => console.log('    ' + l));
}
if (moduleLevel.length) {
  fatal = true;
  console.log(`${moduleLevel.length} call(s) that read the language at module level — frozen at load time; use msg() and translate where shown:`);
  moduleLevel.forEach((l) => console.log('    ' + l));
}
if (fatal) process.exit(1);

const source = collectKeys();
let orphaned = 0;
console.log(`${source.size} translatable strings in the interface.`);
console.log(`${unwrapped.length} piece(s) of on-screen text not wrapped for translation${process.env.SHOW_UNWRAPPED ? ':' : ' (SHOW_UNWRAPPED=1 lists them).'}`);
if (process.env.SHOW_UNWRAPPED) unwrapped.forEach((l) => console.log('    ' + l));
console.log('');

const per = {};
for (const lang of LANGS) {
  const cat = new Set(Object.keys(await loadCatalogue(lang)));
  per[lang] = cat;
  const missing = [...source].filter((k) => !cat.has(k));
  const orphans = [...cat].filter((k) => !source.has(k));
  orphaned += orphans.length;
  const pct = source.size ? Math.round(((source.size - missing.length) / source.size) * 100) : 100;
  console.log(`${lang}: ${cat.size} entries, ${pct}% covered, ${missing.length} untranslated, ${orphans.length} orphaned`);
  orphans.slice(0, 10).forEach((k) => console.log(`    orphan: ${JSON.stringify(k)}`));
  if (process.env.SHOW_MISSING) missing.forEach((k) => console.log(`    missing: ${JSON.stringify(k)}`));
}

const onlyFr = [...per.fr].filter((k) => !per.zh.has(k));
const onlyZh = [...per.zh].filter((k) => !per.fr.has(k));
if (onlyFr.length || onlyZh.length) {
  console.log(`\nLanguages disagree: ${onlyFr.length} only in fr, ${onlyZh.length} only in zh.`);
  onlyFr.slice(0, 5).forEach((k) => console.log(`    fr only: ${JSON.stringify(k)}`));
  onlyZh.slice(0, 5).forEach((k) => console.log(`    zh only: ${JSON.stringify(k)}`));
}

if (orphaned) { console.log(`\n${orphaned} orphaned entries — their English wording changed in the source.`); process.exit(1); }
