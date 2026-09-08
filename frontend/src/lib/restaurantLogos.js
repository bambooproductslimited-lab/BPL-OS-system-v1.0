// Real brand logos for the two restaurants, provided by the user (not
// generated) and stored as static assets under public/restaurant-logos —
// Bamboo Products Limited has no logo of its own here, so it intentionally
// has no entry and callers fall back to plain text for it.
var LOGO_BY_COMPANY_CODE = {
  SB: '/restaurant-logos/star-bar.png',
  BG1: '/restaurant-logos/bamboo-garden.png'
};

export function restaurantLogoUrl(companyCode) {
  return LOGO_BY_COMPANY_CODE[companyCode] || null;
}
