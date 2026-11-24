import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { Icon, fmtDate } from '../../components/DashKit';
import { matchesQuery } from '../../components/SearchInput';
import { tr } from '../../lib/i18n.jsx';
import { StageTag, addDays, todayISO } from './crmShared';
import { GROUP_KINDS, GROUP_STEPS, kindOf } from './leadGroupKinds';
import './LeadGroups.css';

// Groups of leads on the Leads page (CrmLeadsPage.jsx): the people from a
// fair or an event (GEXPO 2026), a list or a campaign, each group with how
// far its follow-up has got; making and changing a group; and putting
// contacts in it — from a spreadsheet, a phone's contacts, a pasted list, or
// the leads already in the OS. Backend: crmLeadGroups.service.js.

const SHOWN = 6;

function GroupCard({ g, active, canManage, onPick, onEdit, onAdd }) {
  const kind = kindOf(g.kind);
  const c = g.counts;
  const reached = c.total - c.notContacted;
  return (
    <article className={'lg-card' + (active ? ' is-on' : '')}>
      <div className="lg-card-head">
        <span className="lg-ico" aria-hidden="true"><Icon name={kind.icon} /></span>
        <div className="lg-card-title">
          <strong>{g.name}</strong>
          <span className="dk-muted tl-small">{[tr(kind.label), g.heldOn && fmtDate(g.heldOn), g.place].filter(Boolean).join(' · ')}</span>
        </div>
        {canManage && <button type="button" className="dk-link" onClick={() => onEdit(g)}>{tr('Edit')}</button>}
      </div>
      <div className="lg-total">
        <b>{c.total}</b> {c.total === 1 ? tr('contact') : tr('contacts')}
        {c.total > 0 && <span className="dk-muted"> · {tr('{pct}% reached', { pct: Math.round(reached / c.total * 100) })}</span>}
      </div>
      {c.total > 0 ? (
        <>
          <div className="lg-bar" role="img" aria-label={GROUP_STEPS.map((s) => c[s.key] + ' ' + tr(s.label)).join(', ')}>
            {GROUP_STEPS.map((s) => c[s.key] > 0 && <span key={s.key} className={'is-' + s.key} style={{ flexGrow: c[s.key] }} />)}
          </div>
          <ul className="lg-key">
            {GROUP_STEPS.map((s) => c[s.key] > 0 && <li key={s.key}><i className={'is-' + s.key} aria-hidden="true" /><b>{c[s.key]}</b> {tr(s.label)}</li>)}
          </ul>
        </>
      ) : <p className="dk-muted tl-small lg-none">{tr('Nobody in it yet. Add the contacts from a spreadsheet, a phone or a list.')}</p>}
      {c.overdue > 0 && <p className="lg-late"><Icon name="clock" /> {c.overdue === 1 ? tr('1 follow-up late') : tr('{n} follow-ups late', { n: c.overdue })}</p>}
      <div className="lg-acts">
        {c.total > 0 && <button type="button" className={'btn ' + (active ? 'btn-primary' : 'btn-secondary')} onClick={() => onPick(active ? '' : g.id)} aria-pressed={active}>{active ? tr('Showing these') : tr('See them')}</button>}
        {canManage && <button type="button" className={'btn ' + (c.total ? 'btn-secondary' : 'btn-primary')} onClick={() => onAdd(g)}>+ {tr('Add contacts')}</button>}
      </div>
    </article>
  );
}

// The groups, newest event first: a card each.
export function GroupsSection({ groups, activeId, canManage, onPick, onNew, onEdit, onAdd }) {
  const [all, setAll] = useState(false);
  const shown = all ? groups.slice() : groups.slice(0, SHOWN);
  // The group being looked at stays in view.
  if (activeId && !shown.some((g) => g.id === activeId)) {
    const g = groups.find((x) => x.id === activeId);
    if (g) shown.push(g);
  }
  return (
    <div className="lg">
      {groups.length ? (
        <div className="lg-cards">
          {shown.map((g) => <GroupCard key={g.id} g={g} active={g.id === activeId} canManage={canManage} onPick={onPick} onEdit={onEdit} onAdd={onAdd} />)}
        </div>
      ) : (
        <div className="lg-empty">
          <Icon name="people" />
          <p>{tr('No groups yet. Make one for each fair or event, contact list or campaign, and put its contacts in it: you see who has been reached and who is still waiting.')}</p>
          {canManage && <button type="button" className="btn btn-primary" onClick={onNew}>+ {tr('New group')}</button>}
        </div>
      )}
      {groups.length > SHOWN && <button type="button" className="dk-link lg-more" onClick={() => setAll(!all)}>{all ? tr('Show fewer') : tr('Show all {n} groups', { n: groups.length })}</button>}
    </div>
  );
}

// Making a group, or changing or deleting one.
export function GroupDialog({ group, onClose, onSaved, onDeleted }) {
  const [f, setF] = useState(() => ({
    name: group ? group.name : '', kind: group ? group.kind : 'event', heldOn: group ? group.heldOn || '' : '',
    place: group ? group.place : '', notes: group ? group.notes : ''
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sure, setSure] = useState(false);
  const set = (p) => setF((o) => ({ ...o, ...p }));
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { ...f, heldOn: f.heldOn || null };
      onSaved(group ? await api.put('/crm/groups/' + group.id, body) : await api.post('/crm/groups', body), !group);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  async function del() {
    setBusy(true); setError(null);
    try { await api.del('/crm/groups/' + group.id); onDeleted(group); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog tl-dialog crm-dialog lg-dialog" role="dialog" aria-modal="true" aria-labelledby="lg-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2 id="lg-title">{group ? tr('Change the group') : tr('New group')}</h2>
        <p className="dialog-body">{tr('A group keeps together the people from one fair or event, list or campaign. A lead can be in several groups.')}</p>
        <div className="tl-form">
          <div className="field tl-span"><label htmlFor="lg-name">{tr('Name')}</label>
            <input id="lg-name" className="input" maxLength={80} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder={tr('e.g. GEXPO 2026')} required autoFocus />
          </div>
          <div className="field tl-span">
            <span className="lg-label" id="lg-kind">{tr('What it is')}</span>
            <div className="ppl-chips" role="radiogroup" aria-labelledby="lg-kind">
              {GROUP_KINDS.map((k) => (
                <button key={k.key} type="button" role="radio" aria-checked={f.kind === k.key} className={'ppl-chip' + (f.kind === k.key ? ' is-on' : '')} onClick={() => set({ kind: k.key })}>{tr(k.label)}</button>
              ))}
            </div>
          </div>
          <div className="field"><label htmlFor="lg-day">{f.kind === 'event' ? tr('When (the first day)') : tr('Date (optional)')}</label>
            <input id="lg-day" className="input" type="date" value={f.heldOn} onChange={(e) => set({ heldOn: e.target.value })} />
          </div>
          <div className="field"><label htmlFor="lg-place">{tr('Where (optional)')}</label>
            <input id="lg-place" className="input" maxLength={120} value={f.place} onChange={(e) => set({ place: e.target.value })} placeholder={tr('e.g. Accra International Conference Centre')} />
          </div>
          <div className="field tl-span"><label htmlFor="lg-notes">{tr('Notes (optional)')}</label>
            <textarea id="lg-notes" className="input" rows={2} maxLength={1000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder={tr('Who was at the stand, what was shown…')} />
          </div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {group && sure && (
          <div className="crm-note is-warn lg-sure">
            <Icon name="warn" />
            <span>{tr('Delete the group {name}? Its {n} leads stay in the OS; only the group goes.', { name: group.name, n: group.counts.total })}</span>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={del}>{tr('Delete the group')}</button>
          </div>
        )}
        <div className="dialog-actions">
          {group && !sure && <button type="button" className="btn btn-secondary lg-del" onClick={() => setSure(true)} disabled={busy}>{tr('Delete…')}</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !f.name.trim()}>{busy ? tr('Saving…') : group ? tr('Save') : tr('Make the group')}</button>
        </div>
      </form>
    </div>
  );
}

const STATUS = {
  new: ['good', () => tr('New lead')],
  existing: ['info', () => tr('Already a lead: joins the group')],
  in_group: ['muted', () => tr('Already in this group')],
  repeat: ['muted', () => tr('Twice in the list')],
  empty: ['muted', () => tr('Nothing to go on')]
};
const ROWS_SHOWN = 100;

// Putting contacts in a group: from a file, a pasted list, or the leads
// already in the OS. A file or list is read first and shown — new, already
// a lead, already in the group, twice — and nothing is saved until Add.
export function AddContactsDialog({ group, leads, people, settings, meId, onClose, onDone }) {
  const [tab, setTab] = useState('file');
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const today = todayISO();
  // The reps to share the new leads between: those with leads already, and me.
  const reps = useMemo(() => {
    const ids = new Set((leads || []).map((l) => l.repId).filter(Boolean));
    if (meId) ids.add(meId);
    return people.filter((p) => ids.has(p.id));
  }, [leads, people, meId]);
  const [opts, setOpts] = useState(() => ({
    repIds: [], followUpOn: addDays(today, 2), receivedOn: group.heldOn && group.heldOn <= today ? group.heldOn : today,
    source: group.kind === 'event' && settings && settings.sources.includes('Fair or event') ? 'Fair or event' : ''
  }));
  const [extraRep, setExtraRep] = useState('');
  const shownReps = extraRep && !reps.some((p) => p.id === extraRep) ? reps.concat(people.filter((p) => p.id === extraRep)) : reps;

  function form(withOptions) {
    const body = new FormData();
    if (tab === 'file' && file) body.append('file', file);
    else body.append('text', text);
    if (withOptions) body.append('options', JSON.stringify({ ...opts, followUpOn: opts.followUpOn || null }));
    return body;
  }
  async function read(f) {
    setPreview(null); setResult(null); setError(null);
    setBusy(true);
    try {
      const body = new FormData();
      if (f) body.append('file', f); else body.append('text', text);
      setPreview(await api.upload('/crm/groups/' + group.id + '/import/preview', body));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setError(null);
    try { setResult(await api.upload('/crm/groups/' + group.id + '/import', form(true))); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  function toggleRep(id) { setOpts((o) => ({ ...o, repIds: o.repIds.includes(id) ? o.repIds.filter((x) => x !== id) : o.repIds.concat(id) })); }

  // The leads already in the OS that are not in the group.
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const notIn = useMemo(() => (leads || []).filter((l) => !(l.groups || []).some((g) => g.id === group.id)), [leads, group.id]);
  const found = useMemo(() => (q.trim() ? notIn.filter((l) => matchesQuery(q, l.name, l.company, l.phone, l.email, l.item, l.location, l.ref, l.source)) : notIn).slice(0, 60), [notIn, q]);
  async function addPicked() {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/crm/groups/' + group.id + '/leads', { leadIds: picked });
      setResult({ added: 0, joined: r.added, inGroup: 0, repeat: 0, empty: 0, perRep: [], group: r.group, byHand: true });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const c = preview ? preview.counts : null;
  const close = () => { if (!busy) { if (result) onDone(result); else onClose(); } };
  return (
    <div className="dialog-backdrop" onClick={close}>
      <div className="dialog tl-dialog crm-dialog lg-add" role="dialog" aria-modal="true" aria-labelledby="lg-add-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="lg-add-title">{tr('Add contacts to {name}', { name: group.name })}</h2>
        {result ? (
          <>
            <div className="crm-note is-good"><Icon name="check" />
              <span>{result.byHand
                ? (result.joined === 1 ? tr('1 lead put in the group.') : tr('{n} leads put in the group.', { n: result.joined }))
                : [result.added === 1 ? tr('Done: 1 new lead.') : tr('Done: {n} new leads.', { n: result.added }),
                  result.joined === 1 ? tr('1 person already among the leads joined the group.') : result.joined > 1 ? tr('{n} people already among the leads joined the group.', { n: result.joined }) : ''].filter(Boolean).join(' ')}</span>
            </div>
            {!result.byHand && (result.inGroup + result.repeat + result.empty) > 0 && (
              <p className="dk-muted tl-small">{tr('Left out: {inGroup} already in the group, {repeat} twice in the list, {empty} with nothing to go on.', result)}</p>
            )}
            {result.perRep.length > 0 && (
              <ul className="dk-rows">
                {result.perRep.map((r) => <li key={r.id} className="dk-row"><div className="dk-row-main"><div className="dk-row-title">{r.name}</div></div><div className="dk-row-side"><div className="dk-row-amount">{r.leads === 1 ? tr('1 new lead') : tr('{n} new leads', { n: r.leads })}</div></div></li>)}
              </ul>
            )}
            <p className="dk-muted tl-small">{tr('The group now has {n} contacts. Each new lead says where they were met, and the managers can see the follow-up on the group\'s card.', { n: result.group.counts.total })}</p>
            <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={() => onDone(result)}>{tr('See the group')}</button></div>
          </>
        ) : (
          <>
            <div className="dk-segment lg-tabs" role="tablist" aria-label={tr('Where the contacts are')}>
              {[['file', tr('A file')], ['paste', tr('Paste a list')], ['leads', tr('Leads already here')]].map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} disabled={busy} onClick={() => { setTab(k); setPreview(null); setError(null); }}>{label}</button>
              ))}
            </div>

            {tab === 'file' && (
              <div className="lg-src">
                <p className="dialog-body">{tr('A spreadsheet with a row for each contact (Excel or CSV, whatever the columns are called), or the contacts saved on a phone, exported as a .vcf file.')}</p>
                <label className="lg-file">
                  <input type="file" accept=".xlsx,.csv,.vcf,text/csv,text/vcard,text/x-vcard,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy}
                    onChange={(e) => { const f = e.target.files[0] || null; setFile(f); if (f) read(f); else setPreview(null); }} />
                </label>
                <p className="dk-muted tl-small">{tr('Google Sheets: File → Download → Microsoft Excel (.xlsx). Android: Contacts → Settings → Export. iPhone: share the contacts as a vCard.')}</p>
              </div>
            )}
            {tab === 'paste' && (
              <div className="lg-src">
                <p className="dialog-body">{tr('One contact a line: the name, then the company, phone and email in any order, with commas between. Rows copied from a spreadsheet work too, headings and all.')}</p>
                <textarea className="input lg-paste" rows={7} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} disabled={busy}
                  placeholder={'Kofi Mensah, Mensah Furniture, 024 412 3456, kofi@example.com\nAma Owusu, 020 123 4567\n…'} aria-label={tr('The contacts')} />
                <button type="button" className="btn btn-secondary" disabled={busy || !text.trim()} onClick={() => read(null)}>{busy ? tr('Reading…') : tr('Read the list')}</button>
              </div>
            )}
            {tab === 'leads' && (
              <div className="lg-src">
                <p className="dialog-body">{tr('Leads already in the OS that belong in this group: tick them and add them.')}</p>
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search name, phone, item, place…')} aria-label={tr('Search')} />
                <ul className="lg-pick">
                  {found.map((l) => (
                    <li key={l.id}>
                      <label>
                        <input type="checkbox" checked={picked.includes(l.id)} onChange={() => setPicked((p) => (p.includes(l.id) ? p.filter((x) => x !== l.id) : p.concat(l.id)))} />
                        <span className="lg-pick-main"><b>{l.name}</b><span className="dk-muted tl-small">{[l.company, l.phone, l.source].filter(Boolean).join(' · ') || l.ref}</span></span>
                        <StageTag value={l.stage} />
                      </label>
                    </li>
                  ))}
                  {!found.length && <li className="dk-muted tl-small lg-pick-none">{tr('No lead matches.')}</li>}
                </ul>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={busy || !picked.length} onClick={addPicked}>{picked.length === 1 ? tr('Add 1 lead to the group') : tr('Add {n} leads to the group', { n: picked.length })}</button>
                </div>
              </div>
            )}

            {busy && !preview && tab !== 'leads' && <p className="dk-muted tl-small">{tr('Reading the contacts…')}</p>}
            {error && <div className="error-banner" role="alert">{error}</div>}

            {preview && tab !== 'leads' && (
              <div className="lg-preview">
                <ul className="lg-counts">
                  <li className="is-good"><b>{c.new}</b> {c.new === 1 ? tr('new lead') : tr('new leads')}</li>
                  {c.existing > 0 && <li className="is-info"><b>{c.existing}</b> {c.existing === 1 ? tr('already a lead: joins the group') : tr('already leads: they join the group')}</li>}
                  {c.inGroup > 0 && <li><b>{c.inGroup}</b> {tr('already in this group')}</li>}
                  {c.repeat > 0 && <li><b>{c.repeat}</b> {tr('twice in the list: counted once')}</li>}
                  {c.empty > 0 && <li><b>{c.empty}</b> {tr('with nothing to go on: left out')}</li>}
                </ul>
                {preview.columns.length > 0 && (
                  <p className="dk-muted tl-small">{tr('Columns read: {cols}.', { cols: preview.columns.map((col) => col.heading + (col.field ? '' : ' (' + tr('left out') + ')')).join(', ') })}{preview.sheet ? ' ' + tr('Sheet: {name}.', { name: preview.sheet }) : ''}</p>
                )}
                {c.noContact > 0 && <div className="crm-note is-warn"><Icon name="warn" /> {c.noContact === 1 ? tr('1 new contact has no phone number or email. It is added all the same; find the number later.') : tr('{n} new contacts have no phone number or email. They are added all the same; find the numbers later.', { n: c.noContact })}</div>}
                <div className="lg-table-wrap">
                  <table className="lg-table">
                    <thead><tr><th>#</th><th>{tr('Name')}</th><th>{tr('Company')}</th><th>{tr('Phone')}</th><th>{tr('Email')}</th><th>{tr('What they want')}</th><th>{tr('What happens')}</th></tr></thead>
                    <tbody>
                      {preview.rows.slice(0, ROWS_SHOWN).map((r) => {
                        const s = STATUS[r.status] || STATUS.empty;
                        return (
                          <tr key={r.n} className={'is-' + r.status}>
                            <td className="dk-muted">{r.n}</td>
                            <td>{r.name || <span className="dk-muted">{tr('No name')}</span>}</td>
                            <td>{r.company}</td>
                            <td className="lg-nowrap">{r.phone}</td>
                            <td>{r.email}</td>
                            <td>{r.interest}</td>
                            <td><span className={'dk-status is-' + s[0]}>{s[1]()}</span>{r.lead ? <span className="dk-muted tl-small"> {r.lead.ref}</span> : null}{r.warn === 'no_contact' && <span className="dk-status is-warn lg-warn">{tr('No phone or email')}</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {preview.rows.length > ROWS_SHOWN && <p className="dk-muted tl-small">{tr('And {n} more.', { n: preview.rows.length - ROWS_SHOWN })}</p>}

                {c.new > 0 && (
                  <div className="lg-opts">
                    <h3 className="dk-h3">{tr('The new leads')}</h3>
                    <div className="field">
                      <span className="lg-label" id="lg-reps">{tr('Share them out between')}</span>
                      <div className="ppl-chips" role="group" aria-labelledby="lg-reps">
                        {shownReps.map((p) => (
                          <button key={p.id} type="button" aria-pressed={opts.repIds.includes(p.id)} className={'ppl-chip' + (opts.repIds.includes(p.id) ? ' is-on' : '')} onClick={() => toggleRep(p.id)}>{p.name}</button>
                        ))}
                        <select className="input lg-rep-more" value="" onChange={(e) => { if (e.target.value) { setExtraRep(e.target.value); if (!opts.repIds.includes(e.target.value)) toggleRep(e.target.value); } }} aria-label={tr('Someone else')}>
                          <option value="">{tr('Someone else…')}</option>
                          {people.filter((p) => !shownReps.some((x) => x.id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                      <small className="dk-muted">{opts.repIds.length === 0 ? tr('Nobody picked: they wait for a rep.') : opts.repIds.length === 1 ? tr('All {n} go to {name}.', { n: c.new, name: shownReps.find((p) => p.id === opts.repIds[0]).name })
                        : tr('{n} new leads shared in turn: about {each} each.', { n: c.new, each: Math.ceil(c.new / opts.repIds.length) })}</small>
                    </div>
                    <div className="tl-form">
                      <div className="field"><label htmlFor="lg-follow">{tr('First follow-up on')}</label>
                        <input id="lg-follow" className="input" type="date" value={opts.followUpOn} min={today} onChange={(e) => setOpts((o) => ({ ...o, followUpOn: e.target.value }))} />
                        <small className="dk-muted">{tr('Leave it empty for no date.')}</small>
                      </div>
                      <div className="field"><label htmlFor="lg-received">{tr('Date received')}</label>
                        <input id="lg-received" className="input" type="date" value={opts.receivedOn} max={today} onChange={(e) => setOpts((o) => ({ ...o, receivedOn: e.target.value }))} />
                      </div>
                      <div className="field"><label htmlFor="lg-source">{tr('How they found us')}</label>
                        <select id="lg-source" className="input" value={opts.source} onChange={(e) => setOpts((o) => ({ ...o, source: e.target.value }))}>
                          <option value="">{tr('Not known')}</option>
                          {(settings ? settings.sources : []).map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                )}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={busy || !(c.new + c.existing)} onClick={run}>
                    {busy ? tr('Adding…') : c.existing ? tr('Add {n} new leads and {m} to the group', { n: c.new, m: c.existing }) : c.new === 1 ? tr('Add 1 new lead') : tr('Add {n} new leads', { n: c.new })}
                  </button>
                </div>
              </div>
            )}
            {!preview && tab !== 'leads' && <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button></div>}
          </>
        )}
      </div>
    </div>
  );
}
