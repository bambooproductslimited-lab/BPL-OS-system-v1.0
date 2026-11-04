// Takes the Authenticode signature off a Windows .exe (node.exe), as
// Windows' signtool remove /s does: the hub is put inside it after, which
// would leave a signature that no longer matches (worse than none).
// The certificate table is the last thing in the file: its directory entry
// is zeroed and the file cut where it starts.
var fs = require('fs');
var file = process.argv[2];
var buf = fs.readFileSync(file);
var pe = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\u0000\u0000') throw new Error('Not a Windows program: ' + file);
var opt = pe + 24;
var magic = buf.readUInt16LE(opt);
var dirs = opt + (magic === 0x20b ? 112 : 96);
var certAt = dirs + 4 * 8;
var offset = buf.readUInt32LE(certAt), size = buf.readUInt32LE(certAt + 4);
if (!offset || !size) { console.log('No signature on ' + file); process.exit(0); }
buf.writeUInt32LE(0, certAt);
buf.writeUInt32LE(0, certAt + 4);
fs.writeFileSync(file, buf.subarray(0, offset));
console.log('Signature taken off ' + file + ' (' + size + ' bytes).');
