var config = require('../config');

// The roads between two places, with the traffic on them now: Google's
// Routes API (computeRoutes), asked by the server with a key of its own
// (config.googleRoutesKey — a server key, limited in Google Cloud to the
// Routes API). A motorbike rides Google's two-wheeler roads (Ghana is
// covered, in beta) and a car drives, both with today's traffic and the
// stretches where it is slow or jammed; a bicycle or someone on foot gets
// their roads without traffic, which Google has only for motor traffic.
// No key, or no answer: null, and the maps draw the way as before.
// restaurantDelivery.service.js decides when to ask (and how often).

var ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
var FIELDS = 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals';
// The modes to try for each vehicle, the first Google answers.
var MODES = { motorbike: ['TWO_WHEELER', 'DRIVE'], car: ['DRIVE'], bicycle: ['BICYCLE', 'DRIVE'], on_foot: ['WALK'] };
var WITH_TRAFFIC = { DRIVE: true, TWO_WHEELER: true };
var TIMEOUT_MS = 8000;

var fetcher = function (url, opts) { return fetch(url, opts); };
function setFetchForTests(fn) { fetcher = fn || function (url, opts) { return fetch(url, opts); }; }
function enabled() { return !!config.googleRoutesKey; }

// Google's encoded polyline, as [[lat, lng], …].
function decode(str) {
  var points = [], i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (var k = 0; k < 2; k++) {
      var shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      var delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += delta; else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}
function seconds(s) { var n = parseFloat(String(s || '')); return isFinite(n) ? Math.round(n) : null; }
function latLng(p) { return { location: { latLng: { latitude: p.lat, longitude: p.lng } } }; }

async function ask(from, to, mode) {
  var body = { origin: latLng(from), destination: latLng(to), travelMode: mode, polylineQuality: 'OVERVIEW', languageCode: 'en-GB', regionCode: 'GH', units: 'METRIC' };
  if (WITH_TRAFFIC[mode]) { body.routingPreference = 'TRAFFIC_AWARE'; body.extraComputations = ['TRAFFIC_ON_POLYLINE']; }
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
  try {
    var res = await fetcher(ENDPOINT, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.googleRoutesKey, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    var j = await res.json();
    var r = j && j.routes && j.routes[0];
    if (!r || !r.polyline || !r.polyline.encodedPolyline) return null;
    var points = decode(r.polyline.encodedPolyline);
    if (points.length < 2) return null;
    var last = points.length - 1;
    // Only the slow and jammed stretches are kept; the rest of the road is clear.
    var traffic = ((r.travelAdvisory && r.travelAdvisory.speedReadingIntervals) || [])
      .filter(function (x) { return x.speed === 'SLOW' || x.speed === 'TRAFFIC_JAM'; })
      .map(function (x) { return [Math.min(last, x.startPolylinePointIndex || 0), Math.min(last, x.endPolylinePointIndex == null ? last : x.endPolylinePointIndex), x.speed === 'TRAFFIC_JAM' ? 'jam' : 'slow']; });
    var secs = seconds(r.duration);
    return { points: points, traffic: traffic, seconds: secs, freeSeconds: seconds(r.staticDuration) || secs, meters: r.distanceMeters || 0, mode: mode, withTraffic: !!WITH_TRAFFIC[mode] };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The road from one place to another for this vehicle, or null.
async function route(from, to, vehicle) {
  if (!enabled() || !from || !to) return null;
  var modes = MODES[vehicle] || MODES.motorbike;
  for (var i = 0; i < modes.length; i++) {
    var r = await ask(from, to, modes[i]);
    if (r) return r;
  }
  return null;
}

module.exports = { enabled: enabled, route: route, decode: decode, MODES: MODES, setFetchForTests: setFetchForTests };
