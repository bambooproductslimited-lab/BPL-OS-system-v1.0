// The OS's own address: this page's, except in the sales team's own app at
// sales.oseitutu.com (src/sites/sales.jsx, tools/build-sales.mjs sets
// VITE_OS_URL), where shared documents, meeting links, payment reminders
// and the rest of the OS are still on the OS's address.
export function osOrigin() {
  return (import.meta.env.VITE_OS_URL || window.location.origin).replace(/\/+$/, '');
}
