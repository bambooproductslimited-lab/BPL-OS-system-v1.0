var express = require('express');
var restaurantService = require('../services/restaurant.service');

// Deliberately not behind requireAuth (see restaurant.service.js's
// getMenuItemPhoto) — a plain <img src> can't attach an Authorization
// header, and this needs to render from both the main app and the
// separately-authenticated POS till.
var router = express.Router();

router.get('/:id', async function (req, res, next) {
  try {
    var photo = await restaurantService.getMenuItemPhoto(req.params.id);
    res.setHeader('Content-Type', photo.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // helmet's default (same-origin) makes browsers refuse this image on any
    // other site — and the OS pages (Hostinger) and this server (Render) are
    // different sites, so every menu photo showed as a broken image. These
    // photos are public by design (see above), so they may be shown anywhere.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (photo.buffer) res.end(photo.buffer); // kept in the database (no R2)
    else photo.stream.pipe(res);
  } catch (e) { next(e); }
});

module.exports = router;
