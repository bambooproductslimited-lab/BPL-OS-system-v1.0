// Light/dark mode, applied at the document root.
//
// It used to be applied to <main class="shell-main-dark">, which re-themed
// everything *inside* that element and nothing outside it. The page canvas
// — html, body and the .shell grid — kept the light theme's white
// --color-bg. You could not normally see that, because <main> covered the
// viewport. Anything that made the page wider or taller than <main>'s
// painted area showed it: a wide table pushed the document sideways and a
// white band appeared down the right of the screen, on desktop and iPad
// alike, with the row buttons clipped against it.
//
// So the attribute goes on <html>, where the variables reach html, body and
// .shell as well. .shell-main-dark stays on <main> because page stylesheets
// hang dark-only rules off it (.shell-main-dark .attendance-summary-tile
// and friends) — it is a hook now, not the source of the colours.
//
// Scoped to the shell's lifetime on purpose: the login screen, /pos, /kiosk,
// /share and /enroll-face render outside AppShell and have their own visual
// identity. They never see the attribute, so they are unaffected.
export const THEME_KEY = 'bamboo-os-theme';

export function getInitialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* private mode / storage blocked — fall through to default */ }
  return 'dark';
}

export function applyTheme(theme) {
  try { document.documentElement.setAttribute('data-theme', theme); } catch { /* no DOM (tests) */ }
}

export function clearTheme() {
  try { document.documentElement.removeAttribute('data-theme'); } catch { /* no DOM (tests) */ }
}
