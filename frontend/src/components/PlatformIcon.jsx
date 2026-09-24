// Simple line glyphs for the social tracker's channels (not the platforms'
// own logos): enough to tell Facebook from TikTok at a glance, in the
// platform's color on a tinted tile. Decorative — the channel's name is
// always written next to it.

// Tile colors per platform. The charts keep their own validated palette
// (SocialCharts.jsx CHANNEL_COLORS); this only adds the platforms charts
// never color.
const TONE = {
  facebook: '#2a78d6',
  instagram: '#d9572b',
  tiktok: '#1baf7a',
  youtube: '#c98a00',
  whatsapp: '#1f9d55',
  website: '#4a3aa7',
  googlebusiness: '#3b6fd8',
  tripadvisor: '#1b9a6c',
  linkedin: '#0a66c2',
  twitch: '#8f5ad6',
  thomasnet: '#6b6f76'
};

export function platformTone(platform) { return TONE[platform] || '#6b6f76'; }

const PATHS = {
  facebook: (
    <path d="M13.5 20v-6.5h2.3l.4-2.8h-2.7V9c0-.8.3-1.4 1.4-1.4h1.4V5.2c-.3 0-1.1-.1-2.1-.1-2.1 0-3.5 1.3-3.5 3.6v2h-2.3v2.8h2.3V20" />
  ),
  instagram: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4.5" />
      <circle cx="12" cy="12" r="3.6" />
      <circle cx="16.9" cy="7.1" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  tiktok: (
    <path d="M14 4v10.2a3.3 3.3 0 1 1-3.3-3.3M14 4c.4 2.2 1.9 3.7 4.3 4" />
  ),
  youtube: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="3.5" />
      <path d="m10.5 9.5 4 2.5-4 2.5z" fill="currentColor" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M4.5 19.5 5.6 16A7.8 7.8 0 1 1 8.4 18.6z" />
      <path d="M9.4 9.2c.2 2.3 2.8 5 5.3 5.4l1-1.2-1.6-.9-.7.7c-1-.4-1.9-1.3-2.3-2.3l.7-.7-.9-1.6z" fill="currentColor" stroke="none" />
    </>
  ),
  website: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.3 2.2 3.4 4.9 3.4 8s-1.1 5.8-3.4 8c-2.3-2.2-3.4-4.9-3.4-8S9.7 6.2 12 4z" />
    </>
  ),
  googlebusiness: (
    <>
      <path d="M12 20.5s-6-5.5-6-10.2a6 6 0 1 1 12 0c0 4.7-6 10.2-6 10.2z" />
      <circle cx="12" cy="10.3" r="2.2" />
    </>
  ),
  tripadvisor: (
    <>
      <circle cx="7.8" cy="13" r="3.3" />
      <circle cx="16.2" cy="13" r="3.3" />
      <path d="M4.5 9.2C6.8 7.4 9.3 6.6 12 6.6s5.2.8 7.5 2.6M12 11.2 13.2 13 12 14.8 10.8 13z" />
      <circle cx="7.8" cy="13" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="16.2" cy="13" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  linkedin: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.3 10.5V16M8.3 7.9v.1M11.5 16v-5.5M11.5 13c0-1.6 1-2.6 2.2-2.6s2 .8 2 2.4V16" />
    </>
  ),
  twitch: (
    <path d="M5.5 4 4.5 7v11h3.5v2.2h2L12.2 18h3l4.3-4.3V4zM10.5 8v4.2M14.5 8v4.2" />
  ),
  thomasnet: (
    <>
      <rect x="4.5" y="5" width="15" height="14" rx="1.5" />
      <path d="M8 9h8M8 12.5h8M8 16h5" />
    </>
  )
};

export default function PlatformIcon({ platform, size = 36, className = '' }) {
  const tone = platformTone(platform);
  return (
    <span
      className={'platform-icon ' + className}
      style={{ '--pi-tone': tone, width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {PATHS[platform] || PATHS.website}
      </svg>
    </span>
  );
}
