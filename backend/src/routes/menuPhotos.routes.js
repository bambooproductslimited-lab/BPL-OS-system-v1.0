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
    photo.stream.pipe(res);
  } catch (e) { next(e); }
});

module.exports = router;
