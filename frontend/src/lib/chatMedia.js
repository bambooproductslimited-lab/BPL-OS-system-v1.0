import { API_URL, ApiError, getToken } from '../api/client';
import { tr } from './i18n.jsx';

// Helpers for chat files and photos (MessagesPage.jsx).

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const ACCEPT_FILES = [
  'image/*', 'video/*', 'audio/*',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt', '.rtf', '.odt', '.ods', '.odp', '.heic', '.heif'
].join(',');

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function kindOf(file) {
  const t = String(file.type || '').toLowerCase();
  if (t.startsWith('image/') && t !== 'image/svg+xml') return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(extOf(file.name))) return 'image';
  return 'file';
}

export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

// A label and colour for a document's type, for its file card.
export function fileBadge(name, kind) {
  const ext = extOf(name);
  if (kind === 'audio') return { label: tr('Audio'), tone: '#7d3f5c' };
  if (kind === 'video') return { label: tr('Video'), tone: '#5c3f7d' };
  if (ext === 'pdf') return { label: 'PDF', tone: '#c0392b' };
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return { label: 'DOC', tone: '#2a5fb0' };
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return { label: ext === 'csv' ? 'CSV' : 'XLS', tone: '#1e7a45' };
  if (['ppt', 'pptx', 'odp'].includes(ext)) return { label: 'PPT', tone: '#c2571a' };
  if (ext === 'txt') return { label: 'TXT', tone: '#5f6368' };
  return { label: (ext || tr('File')).toUpperCase().slice(0, 4), tone: '#5f6368' };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}
function canvasToFile(canvas, name, quality) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ? new File([b], name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : null), 'image/jpeg', quality));
}

// Big photos are shrunk before sending (longest side 1920px, JPEG), which
// keeps chats quick on mobile data. GIFs and small images go as they are,
// and anything the browser cannot read (HEIC on most) is sent unchanged.
export async function shrinkPhoto(file) {
  if (kindOf(file) !== 'image' || /gif/i.test(file.type)) return file;
  try {
    const img = await loadImage(file);
    const max = 1920;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await canvasToFile(canvas, file.name, 0.85);
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  }
}

// A square profile or group photo (512px, centred), as JPEG.
export async function squarePhoto(file) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 512, 512);
  const out = await canvasToFile(canvas, 'photo.jpg', 0.88);
  if (!out) throw new Error(tr('That photo could not be read.'));
  return out;
}

// POST a form with files, reporting progress (0–1) as it uploads.
export function uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_URL + path);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data && data.error ? data.error.code : 'error', data && data.error ? data.error.message : tr('Something went wrong.')));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', tr('The upload failed. Check the connection and try again.')));
    xhr.send(formData);
  });
}

// Saves a protected file to the device under its own name.
export async function downloadProtected(path, fileName) {
  const res = await fetch(API_URL + path, { headers: { Authorization: 'Bearer ' + (getToken() || '') } });
  if (!res.ok) throw new Error(tr('That file could not be downloaded.'));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
