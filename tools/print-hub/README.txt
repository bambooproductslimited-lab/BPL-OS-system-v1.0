BAMBOO PRINT HUB
================

Finds the restaurant's receipt printers on the network by itself - Epson,
Star Micronics and the other receipt printers with a network cable - and
prints their tickets from Bamboo OS: kitchen tickets, the order summary,
receipts and bills. Nothing has to be set on the printers.

Put it on ONE computer that stays on at the restaurant and is plugged into
the same router (network) as the printers: the office computer, a laptop
or a Raspberry Pi. The printers then show up in the till under
Till settings > Printers, to be named and given their work.


WINDOWS
-------
1. Unzip this folder somewhere it can stay, such as Documents\Bamboo print hub.
2. Double-click BambooPrintHub.exe.
   If Windows says "Windows protected your PC", click "More info", then "Run anyway".
3. On the till, open Till settings > Printers and press "Copy link".
   Paste it in the print hub's window (Ctrl+V or right-click) and press Enter.
4. Type Y when it asks to start with Windows.
5. Leave the window open. It can be minimised.


MAC, LINUX, RASPBERRY PI
------------------------
Needs Node.js 18 or newer: nodejs.org (on a Raspberry Pi: sudo apt install nodejs).
1. Unzip this folder and open a terminal in it.
2. Run:  ./start.sh
3. Paste the printer link (Till settings > Printers > Copy link) and press Enter.
To have it start by itself on Linux or a Raspberry Pi, after step 3:
   sudo ./install-linux.sh


GOOD TO KNOW
------------
- One hub per restaurant is enough. It looks for new printers every minute.
- Ask whoever looks after the router to keep each printer's address the same
  (a "reserved address"); the hub finds a printer that moved anyway.
- A printer on another network: add its address in bamboo-print-hub.json,
  for example  "extraHosts": ["192.168.2.50"]  and start the hub again.
- To see what the hub sees, open http://localhost:9180 on that computer.
- An office printer it found (it should leave HP, Canon, Brother and the like
  alone): in Till settings > Printers, "Not a printer for tickets: take it off".
