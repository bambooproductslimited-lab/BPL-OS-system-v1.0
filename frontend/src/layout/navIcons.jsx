// One shared icon per nav item (see navModel.js's `icon` field) plus the
// header's bell trigger. Same hand-authored inline-SVG style used
// throughout the app (viewBox 24x24, stroke currentColor) — centralized
// here rather than duplicated per page, since this is the app shell, not
// a per-entity list page.
const ICON_PATHS = {
  home: <><path d="M4 11 12 4l8 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></>,
  user: <><circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.6" /><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  users: <><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" /><path d="M2.5 19c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="16.5" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.6" /><path d="M14.8 13.3c2.6.4 4.7 2.5 4.7 5.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  layers: <><path d="M12 3 21 8l-9 5-9-5 9-5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M3 13l9 5 9-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M4 9.5h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  checklist: <><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 12.5l2.3 2.3L16 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  folder: <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  chat: <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  megaphone: <><path d="M3 10v4h3l7 4V6l-7 4H3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M17 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  document: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  leaf: <><path d="M4 20c8-1 14-7 15-16-9 1-15 7-16 16Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M6 18c4-4 8-8 12-13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  box: <><path d="M12 3.5 20 8 12 12.5 4 8 12 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M4 8v8l8 4.5 8-4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M12 12.5V21" stroke="currentColor" strokeWidth="1.6" /></>,
  building: <><rect x="5" y="3" width="9" height="18" stroke="currentColor" strokeWidth="1.6" /><rect x="14" y="9" width="6" height="12" stroke="currentColor" strokeWidth="1.6" /><path d="M8 7h1M8 11h1M8 15h1M11 7h1M11 11h1M11 15h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  cart: <><path d="M3 4h2.2l2 11.5h10.6l1.7-8.2H6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /><circle cx="16.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /></>,
  wrench: <path d="M14.7 5.3a4.3 4.3 0 0 1-5.6 5.6L4.5 15.5l3 3 4.6-4.6a4.3 4.3 0 0 1 5.6-5.6l-2.6 2.6-2.4-2.4 2.6-2.6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  truck: <><path d="M3 6.5h10v9H3v-9Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M13 10h3.5L20 13v2.5h-7v-5.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><circle cx="7" cy="17" r="1.6" stroke="currentColor" strokeWidth="1.6" /><circle cx="17" cy="17" r="1.6" stroke="currentColor" strokeWidth="1.6" /></>,
  toolbox: <><rect x="3" y="9" width="18" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8 9V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M3 14h18" stroke="currentColor" strokeWidth="1.6" /></>,
  device: <><rect x="3" y="4.5" width="18" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.6" /><path d="M1.5 18.5h21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M9.5 18.5 10 16h4l.5 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></>,
  chart: <><path d="M4 20V11M10 20V6M16 20v-9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M2 20h20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  cash: <><rect x="2.5" y="6" width="19" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" /></>,
  receipt: <><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4v-17Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  gear: <><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" /><path d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4 5.6 5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  key: <><circle cx="8" cy="15" r="4" stroke="currentColor" strokeWidth="1.6" /><path d="M11 12 19 4M16 6l2.5 2.5M13.5 8.5 16 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  history: <><path d="M4 4v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M4.5 9A8 8 0 1 1 6 15.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  plug: <><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M12 17v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  shield: <><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  sparkle: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" /></>,
  bell: <><path d="M12 3.5a5 5 0 0 0-5 5v3.2c0 .7-.3 1.4-.8 1.9L5 15h14l-1.2-1.4a2.7 2.7 0 0 1-.8-1.9V8.5a5 5 0 0 0-5-5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>
};

export default function Icon({ name }) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name] || null}</svg>;
}
