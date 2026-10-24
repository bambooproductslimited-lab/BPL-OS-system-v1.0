// Code 128 barcodes, drawn as SVG, for price labels (Products & Services
// and the restaurant menu): what any USB or Bluetooth scanner reads, and the
// till's own barcode scanning. Set B for text, switching to set C for runs
// of digits so long numbers stay short. Pure: no imports.

// Bar and space widths of each of the 107 symbols (the last is Stop).
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];
const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

// Only printable ASCII goes in a label's code.
export function encodable(text) { return /^[\x20-\x7e]+$/.test(String(text || '')); }

// The symbol values for text: set C for runs of 4 or more digits (or a code
// that is digits only, of even length), set B for the rest.
export function code128Values(text) {
  const s = String(text);
  if (!encodable(s)) throw new Error('Only plain letters, digits and signs fit in a barcode.');
  const values = [];
  let i = 0, set = null;
  const digitsAt = (k) => { let n = 0; while (k + n < s.length && s[k + n] >= '0' && s[k + n] <= '9') n++; return n; };
  while (i < s.length) {
    const run = digitsAt(i);
    const useC = run >= 4 && (run % 2 === 0 || i + run < s.length || set === 'C' || i === 0) ? Math.floor(run / 2) * 2 : 0;
    if (useC >= 4 || (run >= 2 && run === s.length - i && set === 'C')) {
      const n = useC || Math.floor(run / 2) * 2;
      if (set === null) values.push(START_C); else if (set !== 'C') values.push(CODE_C);
      set = 'C';
      for (let k = 0; k < n; k += 2) values.push(Number(s.slice(i + k, i + k + 2)));
      i += n;
      continue;
    }
    if (set === null) values.push(START_B); else if (set !== 'B') values.push(CODE_B);
    set = 'B';
    values.push(s.charCodeAt(i) - 32);
    i++;
  }
  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += values[k] * k;
  values.push(sum % 103, STOP);
  return values;
}

// Widths of every bar and space, in modules, with no quiet zones.
export function code128Widths(text) {
  return code128Values(text).map((v) => PATTERNS[v]).join('').split('').map(Number);
}

// An SVG for it: bars as one path, height in modules; the caller sizes it.
export function code128Svg(text, { height = 40, quiet = 10 } = {}) {
  const widths = code128Widths(text);
  let x = quiet, d = '';
  widths.forEach((w, i) => { if (i % 2 === 0) d += 'M' + x + ' 0h' + w + 'v' + height + 'h-' + w + 'z'; x += w; });
  const total = x + quiet;
  return { width: total, height, path: d };
}
