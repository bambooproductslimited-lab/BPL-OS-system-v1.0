var express = require('express');
var fileStore = require('../lib/fileStore');
var sheets = require('../services/crmProductSheets.service');

// Products a rep sent a customer (crmProductSheets.service.js): the page
// and its photos, deliberately public — the customer opens the link from
// WhatsApp without an account; the unguessable token in it is the
// credential, and it reaches only what was sent, until it expires.
var router = express.Router();

router.get('/:token', async function (req, res, next) {
  try { res.json(await sheets.view(req.params.token, { preview: req.query.preview === '1' })); } catch (e) { next(e); }
});
router.get('/:token/photos/:photoId', async function (req, res, next) {
  try {
    var key = await sheets.photo(req.params.token, req.params.photoId);
    // Shown on the OS's own address (another site than this server's), as the menu photos are.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    await fileStore.send(res, key, 'photo.jpg', true);
  } catch (e) { next(e); }
});

module.exports = router;
