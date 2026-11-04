#!/bin/sh
# Builds the print hub downloads into dist/:
#   bamboo-print-hub-windows.zip  BambooPrintHub.exe (Node built in) + README
#   bamboo-print-hub.zip          the program for Mac, Linux, Raspberry Pi
# The Windows .exe is Node's own node.exe for Windows with the hub inside
# (a Node single executable application), the same Node version as here.
set -e
cd "$(dirname "$0")"
V="$(node -v)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/bamboo-print-hub"
mkdir -p "$CACHE" dist
rm -rf dist/work && mkdir -p dist/work/win dist/work/all
EXE="$CACHE/node-$V-win-x64.exe"
if [ ! -f "$EXE" ]; then
  curl -fsSL "https://nodejs.org/dist/$V/win-x64/node.exe" -o "$EXE.part"
  WANT="$(curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep ' win-x64/node.exe$' | cut -d' ' -f1)"
  GOT="$(sha256sum "$EXE.part" | cut -d' ' -f1)"
  [ "$WANT" = "$GOT" ] || { echo "node.exe checksum does not match"; rm -f "$EXE.part"; exit 1; }
  mv "$EXE.part" "$EXE"
fi
cp bamboo-print-hub.js dist/work/win/
cat > dist/work/win/sea-config.json <<JSON
{ "main": "bamboo-print-hub.js", "output": "sea-prep.blob", "disableExperimentalSEAWarning": true }
JSON
(cd dist/work/win && node --experimental-sea-config sea-config.json)
cp "$EXE" dist/work/win/BambooPrintHub.exe
node strip-signature.js dist/work/win/BambooPrintHub.exe
npx --yes postject@1.0.0-alpha.6 dist/work/win/BambooPrintHub.exe NODE_SEA_BLOB dist/work/win/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 >/dev/null
mkdir -p "dist/work/zipwin/Bamboo print hub"
cp dist/work/win/BambooPrintHub.exe README.txt "dist/work/zipwin/Bamboo print hub/"
rm -f dist/bamboo-print-hub-windows.zip
(cd dist/work/zipwin && zip -qr ../../bamboo-print-hub-windows.zip "Bamboo print hub")
mkdir -p "dist/work/all/Bamboo print hub"
cp bamboo-print-hub.js README.txt start.sh install-linux.sh "dist/work/all/Bamboo print hub/"
chmod +x "dist/work/all/Bamboo print hub/start.sh" "dist/work/all/Bamboo print hub/install-linux.sh"
rm -f dist/bamboo-print-hub.zip
(cd dist/work/all && zip -qr ../../bamboo-print-hub.zip "Bamboo print hub")
rm -rf dist/work
ls -l dist
