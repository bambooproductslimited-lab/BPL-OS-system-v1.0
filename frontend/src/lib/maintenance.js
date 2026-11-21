import { tr } from './i18n.jsx';

// The words of the maintenance & IT work orders (backend
// maintenanceWorkOrders.service.js), shared by the page
// (pages/MaintenanceOrders.jsx) and its Saturday review
// (pages/MaintenancePresent.jsx).

export const KINDS = ['electrical', 'plumbing', 'hvac', 'facilities', 'it', 'mason', 'other'];
const KIND = {
  electrical: ['⚡', () => tr('Electrical')], plumbing: ['🚰', () => tr('Plumbing')], hvac: ['❄️', () => tr('A/C')], facilities: ['🏢', () => tr('Facilities')],
  it: ['💻', () => tr('IT')], mason: ['🧱', () => tr('Mason')], other: ['🔧', () => tr('Other')]
};
export function kindIcon(k) { return (KIND[k] || KIND.other)[0]; }
export function kindName(k) { return (KIND[k] || KIND.other)[1](); }

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const PRIORITY = { low: () => tr('Low'), medium: () => tr('Medium'), high: () => tr('High'), urgent: () => tr('Urgent') };
export function priorityName(p) { return (PRIORITY[p] || (() => p))(); }

export const STATUSES = ['new', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const STATUS = {
  new: () => tr('New'), scheduled: () => tr('Scheduled'), in_progress: () => tr('In progress'), on_hold: () => tr('On hold'),
  completed: () => tr('Completed'), cancelled: () => tr('Cancelled')
};
export function statusName(s) { return (STATUS[s] || (() => s))(); }

// The photos of a job's finished work (backend GET /:id/photos/:n), for
// components/DonePhotos.jsx's DonePhotoStrip.
// base: where the job is read from — the OS's tracker, or My Jobs signed in
// with a kiosk code ('/myjobs/jobs/').
export function jobPhotoPaths(job, base = '/maint-work-orders/') {
  return (job.donePhotos || []).map((p) => base + job.id + '/photos/' + p.n);
}
