// The print hub downloads (tools/print-hub; Till settings → Printers →
// "⬇ Print hub for Windows" and "⬇ Mac, Linux, Raspberry Pi", which ask for
// /downloads/<file> on the site they are opened from). Put into a built
// site's downloads/ folder: the tills' own websites (build-site.mjs pos)
// and the OS (npm run build), whose till and back office show those buttons
// too. Not the other sites: the Windows download is large.
//
// The zips are built first (tools/print-hub/build.sh, which needs the
// internet once for Node's node.exe) when they are missing or older than
// the hub's own files, so a site is never built with an old hub or none.
//
// Run: node tools/hub-downloads.mjs <built folder>   (default: dist)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'print-hub');
export const HUB_DOWNLOADS = ['bamboo-print-hub-windows.zip', 'bamboo-print-hub.zip'];
// What goes into the zips (build.sh): built again when one is newer.
const SOURCES = ['bamboo-print-hub.js', 'README.txt', 'start.sh', 'install-linux.sh', 'build.sh', 'strip-signature.js'];

function stale(built) {
  if (!built.every((f) => existsSync(f))) return true;
  const oldest = Math.min(...built.map((f) => statSync(f).mtimeMs));
  return SOURCES.some((f) => statSync(join(HUB, f)).mtimeMs > oldest);
}

// The two zips, built if need be. → their paths.
export function hubDownloads() {
  const built = HUB_DOWNLOADS.map((f) => join(HUB, 'dist', f));
  if (stale(built)) {
    console.log('Building the print hub downloads (tools/print-hub/build.sh)…');
    execFileSync('sh', [join(HUB, 'build.sh')], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (stale(built)) throw new Error('The print hub downloads were not built: see tools/print-hub/build.sh');
  }
  return built;
}

// Into <out>/downloads/.
export function addHubDownloads(out) {
  if (!existsSync(out)) throw new Error('No built site at ' + out);
  mkdirSync(join(out, 'downloads'), { recursive: true });
  for (const f of hubDownloads()) copyFileSync(f, join(out, 'downloads', basename(f)));
  console.log('Print hub downloads added to ' + join(out, 'downloads'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    addHubDownloads(resolve(process.argv[2] || 'dist'));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
