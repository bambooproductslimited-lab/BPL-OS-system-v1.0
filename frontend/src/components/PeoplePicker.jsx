import { useState } from 'react';
import Photo from './Photo';
import { matchesQuery } from './SearchInput';
import { tr } from '../lib/i18n.jsx';
import './PeoplePicker.css';

// Choosing people (a task's assignees, a project's members): chips for who
// is picked, a search for more. employees are /api/employees rows.
export default function PeoplePicker({ employees, value, onChange, emptyText, placeholder }) {
  const [q, setQ] = useState('');
  const picked = value.map((id) => employees.find((e) => e.id === id)).filter(Boolean);
  const matches = q ? employees.filter((e) => !value.includes(e.id) && matchesQuery(q, e.firstName + ' ' + e.lastName, e.positionTitle, e.code)).slice(0, 6) : [];
  return (
    <div className="pp">
      <div className="pp-chips">
        {picked.map((e) => (
          <button key={e.id} type="button" className="pp-chip" onClick={() => onChange(value.filter((x) => x !== e.id))} aria-label={tr('Remove {name}', { name: e.firstName + ' ' + e.lastName })}>
            <Photo id={e.id} name={e.firstName + ' ' + e.lastName} photo={e.photo} size={22} /> {e.firstName} {e.lastName} <span aria-hidden="true">×</span>
          </button>
        ))}
        {!picked.length && emptyText && <span className="pp-empty">{emptyText}</span>}
      </div>
      <input className="input" value={q} onChange={(ev) => setQ(ev.target.value)} placeholder={placeholder || tr('Add people: type a name…')} aria-label={tr('Add people')} />
      {matches.length > 0 && (
        <div className="pp-list">
          {matches.map((e) => (
            <button key={e.id} type="button" className="pp-item" onClick={() => { onChange([...value, e.id]); setQ(''); }}>
              <Photo id={e.id} name={e.firstName + ' ' + e.lastName} photo={e.photo} size={28} />
              <span><strong>{e.firstName} {e.lastName}</strong><span className="dk-muted">{e.positionTitle}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
