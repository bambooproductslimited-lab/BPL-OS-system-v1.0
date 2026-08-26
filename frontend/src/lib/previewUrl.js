// Uploaded documents (Documents module + employee ID/passport docs) are
// meant to be viewed in the OS, not downloaded — storage.js signs these
// URLs with Content-Disposition: inline so the browser renders them
// instead of triggering a save dialog. For PDFs specifically, appending
// #toolbar=0 to the URL hides the browser's built-in PDF viewer toolbar
// (and the download/print buttons on it) in Chrome/Edge/Firefox. This is
// a convenience, not real protection — anyone can still right-click "Save
// As" or use Ctrl+S on a page already rendered in their own browser; there
// is no way to truly prevent a user from saving content their browser has
// already loaded.
export function isPdf(fileName) {
  return /\.pdf$/i.test(fileName || '');
}

export function toPreviewUrl(url, fileName) {
  return isPdf(fileName) ? url + '#toolbar=0' : url;
}
