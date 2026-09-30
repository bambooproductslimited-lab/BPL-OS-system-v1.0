// Line icons for calls and meetings, in the style of the chat's own glyphs.
const PATHS = {
  phone: <path d="M6.6 3.5h2.7l1.4 4.1-2 1.4a11 11 0 0 0 6.3 6.3l1.4-2 4.1 1.4v2.7a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z" />,
  video: <><rect x="3" y="6.5" width="12.5" height="11" rx="2.2" /><path d="m15.5 10.5 5-3v9l-5-3" /></>,
  videoOff: <><path d="M15.5 13.5v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h1.5M10 6.5h3.5a2 2 0 0 1 2 2v1.5l5-3v9" /><path d="m3 3 18 18" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" /></>,
  micOff: <><path d="M15 9.5V6a3 3 0 0 0-5.8-1M9 9v2a3 3 0 0 0 4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.5 11a6.4 6.4 0 0 1-.6 2.7M12 17.5V21M8.5 21h7" /><path d="m3 3 18 18" /></>,
  hangup: <path d="M3.3 13.2c4.9-4.3 12.5-4.3 17.4 0l-1.6 3-3.6-1.1v-2.5a11 11 0 0 0-7 0v2.5l-3.6 1.1Z" />,
  screen: <><rect x="3" y="4" width="18" height="12.5" rx="2" /><path d="M8.5 20.5h7M12 16.5v4M9.5 10l2.5-2.5 2.5 2.5M12 7.5v5.5" /></>,
  flip: <><path d="M4 8.5V7a2 2 0 0 1 2-2h2l1.5-2h5L16 5h2a2 2 0 0 1 2 2v1.5M20 15.5V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.5" /><path d="m7 12 2-2 2 2M17 12l-2 2-2-2M9 10v2a3 3 0 0 0 3 3M15 14v-2a3 3 0 0 0-3-3" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2.2" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /><path d="M8 13.5h3M8 16.5h6" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  shrink: <><path d="M4 14h6v6M20 10h-6V4" /><path d="m4 20 6-6M20 4l-6 6" /></>,
  grow: <><path d="M14 4h6v6M10 20H4v-6" /><path d="m20 4-6 6M4 20l6-6" /></>,
  people: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><circle cx="17" cy="9.5" r="2.5" /><path d="M16.5 14.2c2.1.2 3.6 1.8 4 4.8" /></>
};

export default function CallIcon({ name, size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
