import { tr } from '../../lib/i18n.jsx';

// How ready a customer seems, as their chats were read (backend
// crmInterests.service.js INTENTS): for the box on a lead or profile
// (ChatReading.jsx) and the tag in the leads list.
export const INTENT = {
  ready_to_buy: { tone: 'good', label: () => tr('Ready to buy') },
  interested: { tone: 'info', label: () => tr('Interested') },
  just_asking: { tone: 'muted', label: () => tr('Just asking') },
  after_sale: { tone: 'info', label: () => tr('Bought before: after-sale') },
  not_a_customer: { tone: 'muted', label: () => tr('Not a customer') },
  unclear: { tone: 'muted', label: () => tr('Not clear yet') }
};
export function intentLabel(i) { return INTENT[i] ? INTENT[i].label() : ''; }
