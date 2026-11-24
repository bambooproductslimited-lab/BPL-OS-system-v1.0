import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { msg } from '../../lib/i18n.jsx';

// Groups of leads (backend crmLeadGroups.service.js): what a group can be,
// and the list of them for a page. Used by LeadGroups.jsx, LeadGroupsBox.jsx
// and CrmLeadsPage.jsx.

export const GROUP_KINDS = [
  { key: 'event', label: msg('Fair or event'), icon: 'calendar' },
  { key: 'list', label: msg('Contact list'), icon: 'doc' },
  { key: 'campaign', label: msg('Campaign'), icon: 'send' },
  { key: 'other', label: msg('Other'), icon: 'people' }
];
export function kindOf(key) { return GROUP_KINDS.find((k) => k.key === key) || GROUP_KINDS[3]; }

// How far a group's people have got, in order, for its bar and its key.
export const GROUP_STEPS = [
  { key: 'notContacted', label: msg('not contacted yet') },
  { key: 'working', label: msg('being worked') },
  { key: 'prospects', label: msg('prospects') },
  { key: 'customers', label: msg('customers') },
  { key: 'lost', label: msg('lost or not leads') }
];

export function useLeadGroups() {
  const [groups, setGroups] = useState(null);
  const load = useCallback(async () => {
    try { setGroups(await api.get('/crm/groups')); } catch { setGroups((g) => g || []); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { groups: groups || [], loaded: groups !== null, reload: load };
}
