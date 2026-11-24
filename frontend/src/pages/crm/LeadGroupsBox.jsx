import { useState } from 'react';
import { api } from '../../api/client';
import { tr } from '../../lib/i18n.jsx';
import './LeadGroups.css';

// A lead's groups, in its window (crmShared.jsx LeadDialog): which fairs,
// lists or campaigns they are in; put them in another or take them out.
export default function LeadGroupsBox({ lead, canManage, busy, onAdd, onRemove }) {
  const [all, setAll] = useState(null);
  const mine = lead.groups || [];
  async function start() {
    try { setAll(await api.get('/crm/groups')); } catch { setAll([]); }
  }
  const others = all ? all.filter((g) => !mine.some((m) => m.id === g.id)) : [];
  return (
    <div className="lg-box">
      <span className="lg-box-label">{tr('Groups')}</span>
      {mine.length ? mine.map((g) => (
        <span key={g.id} className="lg-chip">
          {g.name}
          {canManage && <button type="button" disabled={busy} onClick={() => onRemove(g.id)} aria-label={tr('Take out of {name}', { name: g.name })} title={tr('Take out of {name}', { name: g.name })}>×</button>}
        </span>
      )) : <span className="dk-muted tl-small">{tr('In no group')}</span>}
      {canManage && (all === null
        ? <button type="button" className="dk-link" onClick={start}>+ {tr('Add to a group')}</button>
        : others.length ? (
          <select className="input lg-box-pick" autoFocus defaultValue="" disabled={busy}
            onChange={async (e) => { const id = e.target.value; if (!id) return; await onAdd(id); setAll(null); }} aria-label={tr('Add to a group')}>
            <option value="">{tr('Pick a group…')}</option>
            {others.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        ) : <span className="dk-muted tl-small">{all.length ? tr('In every group already.') : tr('No groups yet: make one on the Leads page.')}</span>)}
    </div>
  );
}
