#!/bin/sh
# Starts the Bamboo print hub by itself with the computer (Linux, Raspberry
# Pi, with systemd). Run ./start.sh once first, to give it the printer link.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(id -u)" != "0" ]; then echo "Run it with sudo: sudo ./install-linux.sh"; exit 1; fi
if [ ! -f "$DIR/bamboo-print-hub.json" ]; then echo "Run ./start.sh once first and paste the printer link."; exit 1; fi
NODE="$(command -v node)"
USER_NAME="${SUDO_USER:-root}"
cat > /etc/systemd/system/bamboo-print-hub.service <<UNIT
[Unit]
Description=Bamboo print hub
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/bamboo-print-hub.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now bamboo-print-hub
echo "Done: the print hub runs now and starts with the computer. See it: journalctl -u bamboo-print-hub -f"
