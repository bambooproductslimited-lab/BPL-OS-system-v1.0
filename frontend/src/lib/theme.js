// Light, dark or glass mode, applied at the document root.
//
// Glass (styles/glass.css) is the light theme made of frosted glass, the
// way Apple's is: see-through panels over a soft colourful backdrop, and a
// blurred glass behind every pop-up. It only adds to the light theme —
// nothing written for 'dark' applies to it — so a screen that never heard
// of it still looks right in it, just less glassy.
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
export const THEMES = ['light', 'dark', 'glass'];

export function getInitialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (THEMES.includes(stored)) return stored;
  } catch { /* private mode / storage blocked — fall through to default */ }
  return 'dark';
}

export function applyTheme(theme) {
  try { document.documentElement.setAttribute('data-theme', theme); } catch { /* no DOM (tests) */ }
}

export function clearTheme() {
  try { document.documentElement.removeAttribute('data-theme'); } catch { /* no DOM (tests) */ }
}

// Paper is always the light theme. Dark mode on paper is a sheet of ink —
// or, with the browser's "Background graphics" off (its default), pale text
// on white that can hardly be read — and glass is see-through panels over
// a coloured backdrop that paper does not have. The browser says when it is
// about to print (window.print(), Ctrl+P, or Print in its menu): the light
// theme goes on for the paper and the chosen one comes back after. The
// dark-only rules hung off .shell-main-dark (see AppShell) step aside too.
export function installPrintTheme() {
  if (typeof window === 'undefined') return;
  let held = null;
  window.addEventListener('beforeprint', () => {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme');
    if (held || !theme || theme === 'light') return;
    held = { theme, dark: [...document.querySelectorAll('.shell-main-dark')] };
    root.setAttribute('data-theme', 'light');
    held.dark.forEach((el) => el.classList.remove('shell-main-dark'));
  });
  window.addEventListener('afterprint', () => {
    if (!held) return;
    document.documentElement.setAttribute('data-theme', held.theme);
    held.dark.forEach((el) => el.classList.add('shell-main-dark'));
    held = null;
  });
}

// Keeps the choice on this device, for every screen of the OS and the
// restaurant sites on it.
export function saveTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* remembered for this visit only */ }
}
