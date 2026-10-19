import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, getToken } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import './FileViewer.css';

// Files open here, over the page, instead of in another tab or outside the
// app: photos and pictures (click to see them full size), PDFs (their
// pages drawn here by pdf.js, the same on a phone as on a computer),
// videos, sound and text. Anything
// else (Word, Excel, a zip…) says so and offers the download. Several files
// open together: ← and → (or the arrows, or the strip along the bottom)
// move between them; Esc closes. Files sit behind sign-in, so each one is
// fetched with the sign-in token and shown from a copy kept in the page.
//
// viewFiles([{ path, name?, mime?, size?, note? }], start) opens it from
// anywhere; <FileViewerHost /> (in the app shell) shows it.

const EVENT = 'bos:view-files';
const MAX_PDF_PAGES = 40;

export function viewFiles(items, start = 0) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { items, start } }));
}

export function FileViewerHost() {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    const on = (e) => setOpen(e.detail && e.detail.items && e.detail.items.length ? e.detail : null);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (!open) return null;
  return <FileViewer key={open.items.map((x) => x.path).join('|')} items={open.items} start={open.start || 0} onClose={() => setOpen(null)} />;
}

function extOf(name) { const m = /\.([a-z0-9]{1,6})$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
export function fileKind(name, mime) {
  const m = String(mime || '').toLowerCase(), ext = extOf(name);
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif)$/.test(m) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return 'image';
  if (m.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
  if (m.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac'].includes(ext)) return 'audio';
  if (m.startsWith('text/') || ['txt', 'csv', 'md', 'json', 'log'].includes(ext)) return 'text';
  return 'other';
}
const TYPE_FOR = { pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/mp4', m4v: 'video/mp4' };
// The colour and the letters on a file's badge.
export function fileBadge(name, mime) {
  const ext = extOf(name), kind = fileKind(name, mime);
  const tone = kind === 'pdf' ? '#e5484d' : kind === 'image' ? '#12a594' : kind === 'video' ? '#8e4ec6' : kind === 'audio' ? '#e5a00d'
    : ['doc', 'docx', 'odt', 'rtf'].includes(ext) ? '#3e63dd' : ['xls', 'xlsx', 'ods', 'csv'].includes(ext) ? '#30a46c'
      : ['ppt', 'pptx', 'key'].includes(ext) ? '#f76b15' : ['zip', 'rar', '7z'].includes(ext) ? '#a18072' : '#8b8d98';
  return { tone, label: (ext || kind).slice(0, 4).toUpperCase(), kind };
}
function sizeText(n) {
  if (!n) return '';
  if (n < 1024) return tr('{n} bytes', { n });
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (Math.round((n / (1024 * 1024)) * 10) / 10) + ' MB';
}
function nameFrom(disposition) { const m = /filename="([^"]+)"/.exec(disposition || ''); return m ? m[1] : null; }
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name || 'file';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function fetchFile(path) {
  return fetch(API_URL + path, { headers: { Authorization: 'Bearer ' + (getToken() || '') } }).then((r) => {
    if (!r.ok) throw new Error('file');
    return r.blob().then((blob) => ({ blob, name: nameFrom(r.headers.get('Content-Disposition')) }));
  });
}

export default function FileViewer({ items, start, onClose }) {
  const [at, setAt] = useState(Math.min(Math.max(0, start), items.length - 1));
  const [shown, setShown] = useState({}); // index → { name, mime, kind, url, blob, text, failed }
  const [zoom, setZoom] = useState(false);
  const [saving, setSaving] = useState(false);
  const urls = useRef([]);
  const item = items[at], got = shown[at];
  const many = items.length > 1;

  const go = useCallback((d) => { setZoom(false); setAt((i) => (i + d + items.length) % items.length); }, [items.length]);

  // Fetch the file on show (not a kind that cannot be shown: that waits for
  // the download).
  useEffect(() => {
    if (shown[at]) return undefined;
    const guess = item.name ? fileKind(item.name, item.mime) : null;
    if (guess === 'other') { setShown((s) => ({ ...s, [at]: { name: item.name, mime: item.mime, kind: 'other' } })); return undefined; }
    let alive = true;
    fetchFile(item.path).then(async ({ blob, name }) => {
      const nm = item.name || name || tr('File'), mime = item.mime || blob.type;
      const kind = fileKind(nm, mime);
      const typed = TYPE_FOR[extOf(nm)] && blob.type !== TYPE_FOR[extOf(nm)] && kind !== 'other' ? new Blob([blob], { type: TYPE_FOR[extOf(nm)] }) : blob;
      const text = kind === 'text' ? (await blob.text()).slice(0, 200000) : null;
      const url = kind === 'other' || kind === 'text' ? null : URL.createObjectURL(typed);
      if (url) urls.current.push(url);
      if (alive) setShown((s) => ({ ...s, [at]: { name: nm, mime, kind, url, blob: typed, text } }));
    }).catch(() => { if (alive) setShown((s) => ({ ...s, [at]: { name: item.name || tr('File'), mime: item.mime, kind: 'other', failed: true } })); });
    return () => { alive = false; };
  }, [at, item, shown]);
  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  // Esc, ← and →, before any window underneath hears them.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); }
      else if (many && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !/^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test((e.target && e.target.tagName) || '')) {
        e.stopPropagation(); e.preventDefault(); go(e.key === 'ArrowRight' ? 1 : -1);
      }
    }
    window.addEventListener('keydown', onKey, true);
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey, true); document.body.style.overflow = before; };
  }, [go, many, onClose]);

  async function download() {
    setSaving(true);
    try {
      if (got && got.blob) saveBlob(got.blob, got.name);
      else { const f = await fetchFile(item.path + (item.path.includes('?') ? '&' : '?') + 'download=1'); saveBlob(f.blob, item.name || f.name); }
    } catch { setShown((s) => ({ ...s, [at]: { ...(s[at] || {}), failed: true } })); } finally { setSaving(false); }
  }

  const name = (got && got.name) || item.name || tr('Loading…');
  const badge = fileBadge(got ? got.name : item.name, got ? got.mime : item.mime);
  const meta = [sizeText(item.size || (got && got.blob ? got.blob.size : 0)), item.note].filter(Boolean).join(' · ');

  return (
    <div className="fv" role="dialog" aria-modal="true" aria-label={name} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fv-top" onClick={(e) => e.stopPropagation()}>
        <span className="fv-badge" style={{ '--fv-c': badge.tone }} aria-hidden="true">{badge.label}</span>
        <span className="fv-title"><strong title={name}>{name}</strong>{meta && <small>{meta}</small>}</span>
        {many && <span className="fv-count">{tr('{a} of {b}', { a: at + 1, b: items.length })}</span>}
        <button type="button" className="fv-btn" onClick={download} disabled={saving}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14" /></svg><span>{saving ? tr('Downloading…') : tr('Download')}</span>
        </button>
        <button type="button" className="fv-btn is-close" onClick={onClose} aria-label={tr('Close')} title={tr('Close') + ' (Esc)'}>×</button>
      </div>

      <div className={'fv-stage is-' + (got ? got.kind : 'loading') + (zoom ? ' is-zoomed' : '')} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {!got ? <span className="fv-wait"><i />{tr('Opening the file…')}</span>
          : got.failed ? <Unshowable badge={badge} name={name} text={tr('The file could not be opened. Try downloading it.')} onDownload={download} />
            : got.kind === 'image' ? <img src={got.url} alt={name} onClick={() => setZoom((z) => !z)} title={zoom ? tr('Click to fit the screen') : tr('Click to see it full size')} />
              : got.kind === 'pdf' ? <PdfPages blob={got.blob} onFail={() => setShown((s) => ({ ...s, [at]: { ...s[at], failed: true } }))} />
                : got.kind === 'video' ? <video src={got.url} controls playsInline onError={() => setShown((s) => ({ ...s, [at]: { ...s[at], failed: true } }))} />
                  : got.kind === 'audio' ? <div className="fv-audio"><span className="fv-badge is-big" style={{ '--fv-c': badge.tone }}>{badge.label}</span><audio src={got.url} controls /></div>
                    : got.kind === 'text' ? <pre className="fv-text">{got.text}</pre>
                      : <Unshowable badge={badge} name={name} text={tr('This kind of file cannot be shown here. Download it to open it on your device.')} onDownload={download} />}
        {many && <>
          <button type="button" className="fv-nav is-prev" onClick={() => go(-1)} aria-label={tr('Previous file')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg></button>
          <button type="button" className="fv-nav is-next" onClick={() => go(1)} aria-label={tr('Next file')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>
        </>}
      </div>

      {many && (
        <div className="fv-strip" onClick={(e) => e.stopPropagation()}>
          {items.map((x, i) => {
            const s = shown[i], b = fileBadge(s ? s.name : x.name, s ? s.mime : x.mime);
            return (
              <button key={x.path} type="button" className={'fv-thumb' + (i === at ? ' is-now' : '')} onClick={() => { setZoom(false); setAt(i); }} title={x.name || ''}>
                {s && s.kind === 'image' && s.url ? <img src={s.url} alt="" /> : <span className="fv-badge" style={{ '--fv-c': b.tone }}>{b.label}</span>}
                <span>{x.name || (s && s.name) || ''}</span>
              </button>
            );
          })}
        </div>
      )}
      <p className="fv-hint" onClick={(e) => e.stopPropagation()}>{many ? tr('← and → move between the files · Esc closes') : tr('Esc closes')}</p>
    </div>
  );
}

function Unshowable({ badge, name, text, onDownload }) {
  return (
    <div className="fv-other">
      <span className="fv-badge is-big" style={{ '--fv-c': badge.tone }}>{badge.label}</span>
      <strong>{name}</strong>
      <p>{text}</p>
      <button type="button" className="fv-btn is-primary" onClick={onDownload}>{tr('Download')}</button>
    </div>
  );
}

// A PDF's pages, drawn one under the other (pdf.js, loaded only when a PDF
// is opened). Not the browser's own viewer: phones have none inside a page,
// and on a computer it names the file by a random number.
function PdfPages({ blob, onFail }) {
  const box = useRef(null);
  const failed = useRef(onFail);
  const [count, setCount] = useState({ shown: 0, pages: 0 });
  useEffect(() => { failed.current = onFail; }, [onFail]);
  useEffect(() => {
    let alive = true, task = null;
    const el = box.current;
    (async () => {
      try {
        // The legacy build: it brings what older browsers (and phones) lack.
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
        task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
        const doc = await task.promise;
        const n = Math.min(doc.numPages, MAX_PDF_PAGES);
        for (let i = 1; i <= n && alive; i++) {
          const page = await doc.getPage(i);
          const width = Math.max(200, el.clientWidth - 24);
          const viewport = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * Math.min(2, window.devicePixelRatio || 1) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
          canvas.className = 'fv-page';
          await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
          if (!alive) return;
          el.appendChild(canvas);
          setCount({ shown: i, pages: doc.numPages });
        }
      } catch { if (alive) failed.current(); }
    })();
    return () => { alive = false; if (task) task.destroy().catch(() => {}); while (el.firstChild) el.removeChild(el.firstChild); };
  }, [blob]);
  return (
    <div className="fv-pages-wrap">
      <div ref={box} className="fv-pages" />
      {!count.shown && <span className="fv-wait"><i />{tr('Opening the file…')}</span>}
      {count.pages > MAX_PDF_PAGES && count.shown === MAX_PDF_PAGES && <p className="fv-more">{tr('The first {n} pages are shown. Download it for all {total}.', { n: MAX_PDF_PAGES, total: count.pages })}</p>}
    </div>
  );
}
