// Which website this build is: the whole OS, or the till ('pos') or the
// kitchen screen ('kds') on an address of its own — see tools/build-site.mjs.
export const SITE = import.meta.env.VITE_SITE || 'os';

// Where the till's "Open the kitchen screen" goes: /kds in the OS, the
// kitchen screen's own address when the till is a website of its own.
export const KDS_URL = import.meta.env.VITE_KDS_URL || '/kds';
// And its "Deliveries": /delivery in the OS, the delivery screen's own address otherwise.
export const DELIVERY_URL = import.meta.env.VITE_DELIVERY_URL || '/delivery';
