import { money } from './currency';

// Formats a saved document's payment_schedule (label/type/value/amount/
// dueDate, amount already snapshotted server-side — see buildPaymentSchedule
// in backend/src/utils/documents.js) into what DocPreview's `paymentSchedule`
// prop expects: {label, dueDate, amount} with amount pre-formatted.
export function formatPaymentSchedule(schedule, currency) {
  return (schedule || []).map((row) => ({ label: row.label, dueDate: row.dueDate || '—', amount: money(row.amount, currency) }));
}
