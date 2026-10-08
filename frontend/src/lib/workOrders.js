import { tr, msg } from './i18n.jsx';
import { codeLabel } from './codeLabels.js';

// Work orders (the OS once called them tasks; the server still keeps them
// in its tasks table). The statuses read the way the workshop's sheet named
// them — "In process", "Suspended", "Awaiting material" — wherever a WO is
// shown, so codeLabel()'s generic words ("Not started", "Waiting") are not
// used for them.
export const WO_STATUSES = ['discussing', 'not_started', 'in_progress', 'awaiting_material', 'waiting', 'under_review', 'completed', 'cancelled'];
export const WO_OPEN = (t) => t.status !== 'completed' && t.status !== 'cancelled';

const LABELS = {
  discussing: msg('Discussing'), not_started: msg('Issued'), in_progress: msg('In process'), awaiting_material: msg('Awaiting material'),
  waiting: msg('Suspended'), under_review: msg('Ready for check'), completed: msg('Completed'), cancelled: msg('Cancelled')
};
export function woStatusLabel(status) { return LABELS[status] ? tr(LABELS[status]) : codeLabel(status); }

// WO-0042, for a number the server sent without its label.
export function woNumber(n) { return n === null || n === undefined ? '' : 'WO-' + String(n).padStart(4, '0'); }
