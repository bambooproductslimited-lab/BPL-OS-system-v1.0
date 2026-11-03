import { API_ORIGIN } from '../api/client';

// A picture from this server that does not load (the file storage refusing
// it, a photo gone) shows nothing rather than the browser's broken-image
// icon: its card's own colour and letter stay, and the picture comes back
// by itself once it loads again (a later visit, the storage fixed). One
// listener for every app and site (main.jsx, sites/*.jsx); a component can
// still handle its own (the till's tiles show their letter instead).
let installed = false;
export function installBrokenImages() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const style = document.createElement('style');
  style.textContent = 'img.is-broken-img{visibility:hidden}';
  document.head.appendChild(style);
  window.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    const src = img.currentSrc || img.src || '';
    if (src.indexOf(API_ORIGIN) !== 0 && src.indexOf('blob:') !== 0) return;
    img.classList.add('is-broken-img');
    img.setAttribute('aria-hidden', 'true');
  }, true);
  window.addEventListener('load', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.classList.contains('is-broken-img')) img.classList.remove('is-broken-img');
  }, true);
}
