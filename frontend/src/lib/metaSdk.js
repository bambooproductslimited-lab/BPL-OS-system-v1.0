// Meta's JavaScript SDK, for WhatsApp's Embedded Signup — Bamboo Products'
// number (components/WhatsAppConnect.jsx) and a restaurant's
// (pages/RestaurantInbox.jsx). Loaded once, ahead of the click: browsers
// block a pop-up opened after a wait.
const SDK = 'https://connect.facebook.net/en_US/sdk.js';
const GRAPH_VERSION = 'v21.0';
let sdkPromise = null;
// Gives up after timeoutMs (a blocker or a slow line can leave the script
// hanging without an error); asking again waits on the same download.
export function loadSdk(appId, timeoutMs) {
  if (window.FB) return Promise.resolve(window.FB);
  if (timeoutMs) {
    return Promise.race([loadSdk(appId), new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]);
  }
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      window.fbAsyncInit = () => { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION }); resolve(window.FB); };
      const s = document.createElement('script');
      s.src = SDK; s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
      s.onerror = () => { sdkPromise = null; reject(new Error('sdk')); };
      document.body.appendChild(s);
    });
  }
  return sdkPromise;
}
// A window message really from Meta's signup window.
export function fromFacebook(origin) { try { return /(^|\.)facebook\.com$/.test(new URL(origin).hostname); } catch { return false; } }
