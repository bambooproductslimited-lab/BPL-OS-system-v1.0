var { AppError } = require('../utils/errors');

// multer file-type allowlisting, by filename extension. This is a
// first-line filter, not content sniffing — a file renamed to end in
// ".pdf" with different bytes inside would still pass, the same way it
// would on most upload forms without a magic-bytes library involved. What
// this does close off is the low-effort case (uploading a script/
// executable/archive with its real extension intact), which is what
// mattered here: uploads land in private storage behind permission checks
// and are only ever handed back out as downloads, never executed — see
// backend/src/lib/storage.js.
function extOf(filename) {
  var m = /\.([a-z0-9]+)$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

function allowlistFilter(allowedExtensions, label) {
  return function (req, file, cb) {
    var ext = extOf(file.originalname);
    if (allowedExtensions.indexOf(ext) < 0) {
      cb(new AppError('invalid', label + ' Accepted file types: ' + allowedExtensions.join(', ').toUpperCase() + '.'));
      return;
    }
    cb(null, true);
  };
}

module.exports = { allowlistFilter: allowlistFilter, extOf: extOf };
