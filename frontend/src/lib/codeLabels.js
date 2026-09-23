import { tr, docTr, msg } from './i18n.jsx';

// The server stores statuses, priorities, conditions, payment methods and
// kinds of thing as codes — 'in_progress', 'bank_transfer', 'under_repair'.
// Screens used to show the code itself, tidied with .replace('_', ' '),
// which is English on every screen whatever language the reader chose. This
// is the one table that turns a code into words.
//
// One table rather than one per page because a code means the same thing
// wherever it appears: a paid invoice and a paid payroll run are both Paid,
// and translating "Paid" once keeps every screen consistent.
//
// A code missing from the table still displays — as the tidied code, the
// way it did before — so a new status added on the server is never blank,
// only untranslated until it's added here.
const LABELS = {
  // Lifecycle
  draft: msg('Draft'), pending: msg('Pending'), planned: msg('Planned'), planning: msg('Planning'),
  scheduled: msg('Scheduled'), not_started: msg('Not started'), in_progress: msg('In progress'),
  under_review: msg('Under review'), on_hold: msg('On hold'), waiting: msg('Waiting'), delayed: msg('Delayed'),
  processing: msg('Processing'), done: msg('Done'), completed: msg('Completed'), fulfilled: msg('Fulfilled'),
  finalized: msg('Finalized'), resolved: msg('Resolved'), open: msg('Open'), closed: msg('Closed'),
  cancelled: msg('Cancelled'), failed: msg('Failed'), published: msg('Published'), synced: msg('Synced'),
  converted: msg('Converted'), replied: msg('Replied'),
  // Records
  active: msg('Active'), inactive: msg('Inactive'), archived: msg('Archived'), disabled: msg('Disabled'),
  terminated: msg('Terminated'), expired: msg('Expired'), renewed: msg('Renewed'), retired: msg('Retired'),
  lost: msg('Lost'), prospect: msg('Prospect'), lead: msg('Lead'), vip: msg('VIP'), former: msg('Former'), blacklisted: msg('Blacklisted'),
  // Decisions and documents
  approved: msg('Approved'), rejected: msg('Rejected'), sent: msg('Sent'), viewed: msg('Viewed'),
  accepted: msg('Accepted'), invoiced: msg('Invoiced'),
  // Money
  unpaid: msg('Unpaid'), partially_paid: msg('Partially paid'), paid: msg('Paid'), overdue: msg('Overdue'),
  void: msg('Void'), voided: msg('Voided'),
  // Goods and equipment
  available: msg('Available'), checked_out: msg('Checked out'), in_stock: msg('In stock'), depleted: msg('Depleted'),
  consumed: msg('Consumed'), disposed: msg('Disposed'), in_use: msg('In use'), in_storage: msg('In storage'),
  under_repair: msg('Under repair'), dispatched: msg('Dispatched'), delivered: msg('Delivered'),
  good: msg('Good'), fair: msg('Fair'), poor: msg('Poor'),
  // Attendance
  present: msg('Present'), late: msg('Late'), absent: msg('Absent'), half_day: msg('Half day'),
  leave: msg('Leave'), off: msg('Off'),
  // Property
  vacant: msg('Vacant'), occupied: msg('Occupied'), reserved: msg('Reserved'), maintenance: msg('Maintenance'),
  unavailable: msg('Unavailable'),
  residential: msg('Residential'), commercial: msg('Commercial'), mixed: msg('Mixed'), land: msg('Land'),
  apartment: msg('Apartment'), room: msg('Room'), office: msg('Office'), shop: msg('Shop'), warehouse: msg('Warehouse'),
  individual: msg('Individual'), company: msg('Company'),
  electricity: msg('Electricity'), water: msg('Water'), gas: msg('Gas'),
  share: msg('By share'), equal: msg('Equal split'), sqm: msg('By floor area'),
  sale: msg('Sale'), rent: msg('Rent'), utility: msg('Utility'), deposit: msg('Deposit'),
  // Priority
  low: msg('Low'), medium: msg('Medium'), normal: msg('Normal'), high: msg('High'), urgent: msg('Urgent'),
  // Payment methods
  cash: msg('Cash'), bank_transfer: msg('Bank transfer'), mobile_money: msg('Mobile money'), card: msg('Card'),
  cheque: msg('Cheque'), square: msg('Square'),
  // Kinds
  tool: msg('Tool'), equipment: msg('Equipment'), material: msg('Material'), product: msg('Product'),
  raw: msg('Raw material'), comment: msg('Comment'), message: msg('Message'), social: msg('Social'),
  web: msg('Web'), directory: msg('Directory'),
  quotation: msg('Quotation'), estimate: msg('Estimate'), invoice: msg('Invoice'), sales_order: msg('Sales order'),
  receipt: msg('Receipt'), waybill: msg('Waybill'), payrun: msg('Payroll run'), booking: msg('Booking'),
  leave_request: msg('Leave request'), procurement_request: msg('Purchase request'), expense: msg('Expense claim'),
  // Employment
  permanent: msg('Permanent'), contract: msg('Contract'), temporary: msg('Temporary'), intern: msg('Intern'),
  casual: msg('Casual'), day_rate: msg('By day'),
  // Pay cycles
  monthly: msg('Monthly'), biweekly: msg('Biweekly'), daily: msg('Daily'),
  other: msg('Other'), none: msg('None')
};

function tidy(code) {
  return String(code).replace(/_/g, ' ');
}

// For the interface: follows the reader's language.
export function codeLabel(code) {
  if (code === null || code === undefined || code === '') return '';
  return Object.prototype.hasOwnProperty.call(LABELS, code) ? tr(LABELS[code]) : tidy(code);
}

// For a customer-facing document, such as the payment method on a receipt:
// the documents' language, whoever is looking (see docTr in lib/i18n.jsx).
export function docCodeLabel(code) {
  if (code === null || code === undefined || code === '') return '';
  return Object.prototype.hasOwnProperty.call(LABELS, code) ? docTr(LABELS[code]) : tidy(code);
}
