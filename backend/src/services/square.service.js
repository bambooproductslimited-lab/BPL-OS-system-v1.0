var { fail } = require('../utils/errors');
var config = require('../config');

// Thin Square Connect API v2 client — used only by squareImport.service.js
// for the one-time historical import, not a live sync. Auth is a single
// Bearer Production Access Token (config.square.accessToken), generated
// once in the Square Developer Dashboard for the seller's own account —
// no OAuth app/client-secret exchange needed since we only ever act on the
// token owner's own data.
//
// Square-Version is pinned to a fixed date rather than left off — Square's
// API is versioned by release date and each version can change field
// shapes/behavior; an unpinned request silently rides whatever is "current"
// on the day it happens to run, which is the opposite of what a financial
// data importer wants. Bump this deliberately (and re-check the fields this
// importer relies on) if Square deprecates it, not by accident.
var SQUARE_VERSION = '2025-01-23';

async function squareRequest(method, path, body) {
  if (!config.square.configured) fail('invalid', 'Square is not configured — set SQUARE_ACCESS_TOKEN on the server.');
  var res = await fetch(config.square.baseUrl + path, {
    method: method,
    headers: {
      Authorization: 'Bearer ' + config.square.accessToken,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok || data.errors) {
    var detail = (data.errors && data.errors[0] && data.errors[0].detail) || res.status;
    fail('invalid', 'Square API error on ' + method + ' ' + path + ': ' + detail);
  }
  return data;
}

// Cursor pagination is the same shape across every Square list/search
// endpoint used here: a `cursor` field in the response means there's
// another page, echoed back as a request param/body field until absent.
async function paginateGet(path, params, itemsKey) {
  var out = [];
  var cursor = undefined;
  do {
    var qs = Object.assign({}, params || {});
    if (cursor) qs.cursor = cursor;
    var query = Object.keys(qs).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(qs[k]); }).join('&');
    var data = await squareRequest('GET', path + (query ? '?' + query : ''));
    out = out.concat(data[itemsKey] || []);
    cursor = data.cursor;
  } while (cursor);
  return out;
}

async function paginatePost(path, body, itemsKey) {
  var out = [];
  var cursor = undefined;
  do {
    var data = await squareRequest('POST', path, Object.assign({}, body, cursor ? { cursor: cursor } : {}));
    out = out.concat(data[itemsKey] || []);
    cursor = data.cursor;
  } while (cursor);
  return out;
}

async function listLocations() {
  var data = await squareRequest('GET', '/v2/locations');
  return data.locations || [];
}

function listAllCustomers() {
  return paginateGet('/v2/customers', { limit: 100 }, 'customers');
}

// types=ITEM returns each CatalogItem with its variations already nested
// inline (item_data.variations: CatalogObject[], each carrying a fully
// populated item_variation_data) — no separate ITEM_VARIATION fetch needed.
// CATEGORY objects come back in the same flat list (ListCatalog doesn't
// nest unrelated types the way SearchCatalogObjects's related_objects
// does), so the caller separates them by `.type`.
function listAllCatalogItems() {
  return paginateGet('/v2/catalog/list', { types: 'ITEM,CATEGORY' }, 'objects');
}

// OPEN as well as COMPLETED: an order stays OPEN until its invoice is paid
// in full, so a still-outstanding Square invoice's order — which is exactly
// the kind of real, currently-unpaid invoice this import needs to bring
// over correctly — would otherwise be skipped, losing its real line items
// (the Square Invoice object itself never carries them; only the Order
// does). CANCELED orders are deliberately excluded — those aren't real
// sales.
function searchAllOrders(locationIds) {
  return paginatePost('/v2/orders/search', {
    location_ids: locationIds,
    limit: 500,
    query: { filter: { state_filter: { states: ['OPEN', 'COMPLETED'] } } }
  }, 'orders');
}

function listAllInvoices(locationId) {
  return paginateGet('/v2/invoices', { location_id: locationId, limit: 200 }, 'invoices');
}

function listAllPayments(locationId) {
  return paginateGet('/v2/payments', { location_id: locationId, limit: 100 }, 'payments');
}

module.exports = {
  listLocations: listLocations,
  listAllCustomers: listAllCustomers,
  listAllCatalogItems: listAllCatalogItems,
  searchAllOrders: searchAllOrders,
  listAllInvoices: listAllInvoices,
  listAllPayments: listAllPayments
};
