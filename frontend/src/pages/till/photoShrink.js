import { API_URL } from '../../api/client';

// A photo taken on the till (a receipt, a bank slip, a delivery in place)
// made small enough to send in a request: at most `max` pixels across, as a
// JPEG data URL.
export function shrinkPhoto(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo.')); };
    img.src = url;
  });
}

// A photo kept by the till's API, read with the till's own token (an <img>
// cannot send it): an object URL to show, or null.
export async function tillPhotoUrl(path, token) {
  try {
    const res = await fetch(API_URL + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch { return null; }
}
