var config = require('../config');

// WhatsApp Business and Google Analytics (Website) have no "Connect"
// button — both are configured entirely via server env vars (see
// config.js), so their connected status has to reflect that live config
// rather than a DB flag toggled by an OAuth callback like every other
// marketing integration. Shared between settings.service.js (the
// Integrations page) and marketing.service.js (the Social Tracker's
// channel cards, which independently look up the same settings.integrations
// row) so both agree on the same live state instead of drifting.
var ENV_CONFIGURED_INTEGRATIONS = {
  whatsappbusiness: function () { return config.whatsapp.configured; },
  googleanalytics: function () { return config.website.configured; },
  squareup: function () { return config.square.configured; }
};

// apiKey is blanked too since nothing is ever stored in settings.integrations
// for either of them.
function withLiveConfigState(list) {
  return list.map(function (i) {
    var isConfigured = ENV_CONFIGURED_INTEGRATIONS[i.id];
    return isConfigured ? Object.assign({}, i, { connected: isConfigured(), apiKey: '' }) : i;
  });
}

module.exports = { withLiveConfigState: withLiveConfigState };
