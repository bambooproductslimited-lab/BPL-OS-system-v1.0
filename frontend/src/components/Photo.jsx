import { useEffect, useState } from 'react';
import { API_URL, getToken } from '../api/client';

// Profile and group photos, and chat files. They sit behind sign-in, and an
// <img src> cannot send the sign-in token, so each is fetched with it and
// shown from a local copy (an object URL), cached for the visit. A version
// (when the photo last changed) is part of the cache key, so a new photo
// shows at once everywhere.

const cache = new Map(); // key -> Promise<string | null>

export function fetchBlobUrl(path, version) {
  const key = path + '#' + (version || '');
  if (!cache.has(key)) {
    cache.set(key, fetch(API_URL + path, { headers: { Authorization: 'Bearer ' + (getToken() || '') } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => { cache.delete(key); return null; }));
  }
  return cache.get(key);
}
export function forgetBlob(path) {
  Array.from(cache.keys()).forEach((k) => { if (k.startsWith(path + '#')) cache.delete(k); });
}

// The object URL for a protected file, or null while loading / if missing.
// path null means "nothing to load".
export function useBlobUrl(path, version) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!path) return undefined;
    fetchBlobUrl(path, version).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [path, version]);
  return url;
}

const COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
export function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
export function colorFor(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

// A round photo, or initials (a person) / a people glyph (a group) / a box
// (a product, drawn with rounded corners) when there is none. photo is the
// version from the API (null = no photo); for "me" pass photo="probe" to try
// loading it anyway.
export default function Photo({ kind = 'person', id, name, photo, size = 40, className = '' }) {
  const path = photo && id
    ? (kind === 'group' ? '/messages/conversations/' + id + '/photo' : kind === 'product' ? '/products/' + id + '/photo' : '/messages/people/' + id + '/photo')
    : null;
  const url = useBlobUrl(path, photo);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)), background: url ? undefined : colorFor(name) };
  return (
    <span className={'photo photo-' + kind + ' ' + className} style={style} aria-hidden="true">
      {url ? <img src={url} alt="" /> : kind === 'product' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <path d="M12 3.5 20 8 12 12.5 4 8 12 3.5Z" /><path d="M4 8v8l8 4.5 8-4.5V8M12 12.5V21" />
        </svg>
      ) : kind === 'group' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.6c1.6.7 2.6 2.2 3 4.4" />
        </svg>
      ) : initials(name)}
    </span>
  );
}
