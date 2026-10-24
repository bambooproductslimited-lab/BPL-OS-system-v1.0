var bookings = require('../services/bookings.service');
var restaurantBookings = require('../services/restaurantBookings.service');

// Reminders before bookings: Bamboo Products' appointments
// (bookings.service remindDue) and the restaurants' tables
// (restaurantBookings remindDue), checked every quarter of an hour; each
// booking reminded once.
var INTERVAL_MS = 15 * 60 * 1000;

async function runOnce() {
  try {
    var n = await bookings.remindDue();
    if (n) console.log('Booking reminders: ' + n + ' sent.');
  } catch (e) {
    // Tried again on the next round; it must never take the server down.
    console.error('Booking reminders failed:', e.message);
  }
  try {
    var t = await restaurantBookings.remindDue();
    if (t) console.log('Table reminders: ' + t + ' sent.');
  } catch (e) {
    console.error('Table reminders failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 2 * 60 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
