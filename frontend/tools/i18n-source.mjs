// Reads the interface source the way the translation tools need it: as
// syntax trees, not text. Shared by tools/i18n-audit.mjs and the script
// that assembles the catalogues, so both agree exactly on which strings
// count as translation keys.
//
// A regex over the source was the first version of this, and it was wrong
// in the ways regexes over code always are — escaped quotes, template
// literals, a tr( inside a comment. Vite already ships a parser that
// understands JSX, so there is nothing to install.
import { readFileSync, globSync, existsSync } from 'node:fs';
import { parseAst } from 'vite';

// The ways a string enters a catalogue. tr() translates into the reader's
// language (trNodes() too, for a sentence with markup in it), docTr() into
// the documents' language, and msg() only marks a string in a module-level
// constant that is translated later, where it is shown (see lib/i18n.jsx
// for why each exists).
export const KEY_FUNCTIONS = new Set(['tr', 'trNodes', 'docTr', 'msg']);

export function sourceFiles() {
  return globSync('src/**/*.{jsx,js}')
    .filter((f) => !f.startsWith('src/locales/'))
    .sort();
}

export function parseFile(file) {
  const code = readFileSync(file, 'utf8');
  return { code, ast: parseAst(code, { lang: file.endsWith('.jsx') ? 'jsx' : 'js' }) };
}

// Depth-first walk with the parent chain, which is what every check here
// needs: whether a call sits inside any function, whether an identifier is
// a reference or only a property name.
export function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  const next = parents.concat([node]);
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, next));
    else if (value && typeof value === 'object') walk(value, visit, next);
  }
}

// The literal first argument of a tr()/docTr()/msg() call, or null when the
// key is computed — tr(item.label), which is how msg() strings are shown.
export function literalKey(call) {
  const arg = call.arguments[0];
  if (!arg) return null;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) return arg.quasis[0].value.cooked;
  return null;
}

export function isKeyCall(node) {
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && KEY_FUNCTIONS.has(node.callee.name);
}

// Words the server sends that are fixed in its own code rather than typed
// by anyone: the permission catalogue's groups and labels, and the
// integrations' categories and descriptions. Screens show them with
// tr(p.label). The keys are read here from the backend's reference data, so
// the catalogue follows the real list instead of a copy of it that would
// drift. (Names people give things — roles, departments, companies — are
// data and stay as typed.)
const SERVER_VOCABULARY = '../backend/src/db/referenceData.js';
const SERVER_FIELDS = { PERMISSIONS: ['group', 'label'], defaultIntegrations: ['category', 'description'] };

export function serverKeys() {
  const keys = new Set();
  if (!existsSync(SERVER_VOCABULARY)) return keys;
  const { ast } = parseFile(SERVER_VOCABULARY);
  walk(ast, (node) => {
    let name = null;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') name = node.id.name;
    if (node.type === 'FunctionDeclaration' && node.id) name = node.id.name;
    const fields = name && SERVER_FIELDS[name];
    if (!fields) return;
    walk(node, (obj) => {
      if (obj.type !== 'ObjectExpression') return;
      for (const prop of obj.properties) {
        if (prop.type === 'Property' && prop.key.type === 'Identifier' && fields.includes(prop.key.name) &&
            prop.value.type === 'Literal' && typeof prop.value.value === 'string') keys.add(prop.value.value);
      }
    });
  });
  return keys;
}

// Every literal key in the interface, plus the server's fixed vocabulary.
export function collectKeys() {
  const keys = serverKeys();
  for (const file of sourceFiles()) {
    const { ast } = parseFile(file);
    walk(ast, (node) => {
      if (!isKeyCall(node)) return;
      const key = literalKey(node);
      if (key !== null) keys.add(key);
    });
  }
  return keys;
}

export async function loadCatalogue(lang) {
  const mod = await import(new URL(`../src/locales/${lang}.js`, import.meta.url));
  return mod.default;
}
