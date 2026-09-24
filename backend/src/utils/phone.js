// Phone numbers as the outside services want them. Most numbers in the OS
// are typed as people say them: "024 412 3456", "+233 24 412 3456",
// "0244123456".

// International digits, no plus: 233244123456. Null if it can't be a phone.
function internationalNumber(phone) {
  var d = String(phone || '').replace(/\D/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.length === 10 && d[0] === '0') return '233' + d.slice(1);
  if (d.length === 9) return '233' + d;
  if (d.length === 12 && d.indexOf('233') === 0) return d;
  if (d.length >= 11 && d.length <= 15 && d[0] !== '0') return d; // another country's number, already international
  return null;
}

// For showing on screen without giving the whole number away: "•••• 3456".
function maskedNumber(phone) {
  var d = String(phone || '').replace(/\D/g, '');
  return d.length >= 4 ? '•••• ' + d.slice(-4) : '••••';
}

module.exports = { internationalNumber: internationalNumber, maskedNumber: maskedNumber };
