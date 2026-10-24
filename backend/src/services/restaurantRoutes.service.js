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

// A day's round of site visits (crmRoute.service.js): by car, from origin
// through every stop in the order Google finds quickest with today's
// traffic, to destination (back to origin when none is given). A place is
// { lat, lng } or { address } — Google reads the address, and where it put
// it comes back as the leg's end. Up to 25 stops. Each leg: its road, its
// slow and jammed stretches, how long with traffic and without, how far.
// null without a key or an answer.
var TOUR_FIELDS = 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex,routes.legs.duration,routes.legs.staticDuration,' +
  'routes.legs.distanceMeters,routes.legs.polyline.encodedPolyline,routes.legs.startLocation,routes.legs.endLocation,routes.legs.travelAdvisory.speedReadingIntervals';
var TOUR_TIMEOUT_MS = 12000;
function waypoint(p) { return p.address ? { address: p.address } : latLng(p); }
function placeOf(loc) { var l = loc && loc.latLng; return l && isFinite(l.latitude) && isFinite(l.longitude) ? { lat: l.latitude, lng: l.longitude } : null; }
async function tour(origin, stops, destination) {
  if (!enabled() || !origin || !stops || !stops.length || stops.length > 25) return null;
  var body = {
    origin: waypoint(origin), destination: waypoint(destination || origin), intermediates: stops.map(waypoint), optimizeWaypointOrder: stops.length > 1,
    travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', extraComputations: ['TRAFFIC_ON_POLYLINE'],
    polylineQuality: 'OVERVIEW', languageCode: 'en-GB', regionCode: 'GH', units: 'METRIC'
  };
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, TOUR_TIMEOUT_MS);
  try {
    var res = await fetcher(ENDPOINT, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.googleRoutesKey, 'X-Goog-FieldMask': TOUR_FIELDS },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    var j = await res.json();
    var r = j && j.routes && j.routes[0];
    if (!r || !Array.isArray(r.legs) || r.legs.length !== stops.length + 1) return null;
    var order = Array.isArray(r.optimizedIntermediateWaypointIndex) && r.optimizedIntermediateWaypointIndex.length === stops.length
      ? r.optimizedIntermediateWaypointIndex : stops.map(function (x, i) { return i; });
    var legs = r.legs.map(function (leg) {
      var points = leg.polyline && leg.polyline.encodedPolyline ? decode(leg.polyline.encodedPolyline) : [];
      var last = Math.max(0, points.length - 1);
      var traffic = ((leg.travelAdvisory && leg.travelAdvisory.speedReadingIntervals) || [])
        .filter(function (x) { return x.speed === 'SLOW' || x.speed === 'TRAFFIC_JAM'; })
        .map(function (x) { return [Math.min(last, x.startPolylinePointIndex || 0), Math.min(last, x.endPolylinePointIndex == null ? last : x.endPolylinePointIndex), x.speed === 'TRAFFIC_JAM' ? 'jam' : 'slow']; });
      var secs = seconds(leg.duration);
      return { points: points, traffic: traffic, seconds: secs, freeSeconds: seconds(leg.staticDuration) || secs, meters: leg.distanceMeters || 0, from: placeOf(leg.startLocation), to: placeOf(leg.endLocation) };
    });
    var total = seconds(r.duration);
    return { order: order, legs: legs, seconds: total, freeSeconds: seconds(r.staticDuration) || total, meters: r.distanceMeters || 0 };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { enabled: enabled, route: route, tour: tour, decode: decode, MODES: MODES, setFetchForTests: setFetchForTests };
