var express = require('express');
var calls = require('../services/calls.service');

// A meeting's guest link (calls.service.js): people outside the company join
// a booked meeting by name, with no account. The link itself is the key; it
// only opens during the meeting's window, and tries are limited per address.
var router = express.Router();
function wrap(fn) { return async function (req, res, next) { try { await fn(req, res); } catch (e) { next(e); } }; }

// Decline on a phone's call pop-up (public/sw.js): the pass in the pop-up is
// the only key, good for one call, one person, five minutes.
router.post('/call-decline', wrap(async function (req, res) { res.json(await calls.declineByPass((req.body || {}).pass)); }));
router.get('/:token', wrap(async function (req, res) { res.json(await calls.guestView(req.params.token)); }));
router.post('/:token/join', wrap(async function (req, res) { res.json(await calls.guestJoin(req.params.token, (req.body || {}).name, req.ip)); }));
router.post('/:token/heartbeat', wrap(async function (req, res) { res.json(await calls.guestHeartbeat(req.params.token, (req.body || {}).guestId)); }));
router.post('/:token/leave', wrap(async function (req, res) { res.json(await calls.guestLeave(req.params.token, (req.body || {}).guestId)); }));

module.exports = router;
