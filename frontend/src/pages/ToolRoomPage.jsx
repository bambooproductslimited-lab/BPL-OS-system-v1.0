import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import Photo from '../components/Photo';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';

// Tool room inventory: tools, equipment and materials — separate from the
// finished-goods Products & Inventory module. Same "explains itself" layout
// as the dashboards (components/DashKit.jsx): the key numbers (on the shelf,
// checked out, materials running low, needing repair), what stands out
// (tools not brought back on time, materials about to run out at the rate
// they are used, one person holding a lot), who has what — with a call or
// WhatsApp button to chase it — and the items as cards or a list. A tool is
// checked out with a day it is due back and checked in with the condition it
// came back in; a material is issued or restocked by quantity. Every
// movement is in the item's history (toolRoom.service.js, migration 0088).
// The sheet import is unchanged.

const KIND_LABELS = { tool: msg('Tool'), equipment: msg('Equipment'), material: msg('Material') };
const CONDITIONS = [{ key: 'good', label: msg('Good') }, { key: 'fair', label: msg('Fair') }, { key: 'poor', label: msg('Poor') }, { key: 'under_repair', label: msg('Under repair') }];
const EMPTY_FORM = { code: '', name: '', kind: 'tool', category: '', unit: 'each', quantityOnHand: '', reorderLevel: '', condition: 'good', location: 'Tool room', notes: '' };
const LONG_OUT = 14;

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function inDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); }
function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(String(iso).slice(0, 10) + 'T00:00') - t) / 86400000);
}
function qtyText(n, unit) {
  const v = Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 2 });
  return unit && unit !== 'each' ? v + ' ' + unit : v;
}
function conditionLabel(c) { return tr((CONDITIONS.find((x) => x.key === c) || CONDITIONS[0]).label); }
function isMaterial(it) { return it.kind === 'material'; }
// a material's condition is only worth showing when something is wrong
function showCondition(it) { return it.status !== 'retired' && (it.kind !== 'material' || it.condition !== 'good'); }
function needsRepair(it) { return it.status !== 'retired' && (it.condition === 'poor' || it.condition === 'under_repair'); }
// days a material lasts at the rate it was used over the last 30 days
function daysLeft(it) { return it.used30 > 0 ? Math.floor(it.quantityOnHand / (it.used30 / 30)) : null; }
function outText(it) {
  const d = daysUntil(it.dueBack);
  if (d === null) return { tone: it.daysOut >= LONG_OUT ? 'warn' : 'info', text: it.daysOut ? (it.daysOut === 1 ? tr('Out 1 day, no return day') : tr('Out {n} days, no return day', { n: it.daysOut })) : tr('Out since today') };
  if (d < 0) return { tone: 'bad', text: -d === 1 ? tr('1 day late') : tr('{n} days late', { n: -d }) };
  if (d === 0) return { tone: 'warn', text: tr('Due back today') };
  return { tone: 'info', text: tr('Due back {date}', { date: fmtDate(it.dueBack) }) };
}

const KIND_ICON = {
  tool: <path d="M14.7 5.3a4.3 4.3 0 0 1-5.6 5.6L4.5 15.5l3 3 4.6-4.6a4.3 4.3 0 0 1 5.6-5.6l-2.6 2.6-2.4-2.4 2.6-2.6Z" />,
  equipment: <><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>,
  material: <><path d="M12 3.5 20 8 12 12.5 4 8 12 3.5Z" /><path d="M4 8v8l8 4.5 8-4.5V8M12 12.5V21" /></>
};
function Badge({ it, size = 44 }) {
  return (
    <span className={'tl-badge is-' + it.kind} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{KIND_ICON[it.kind] || KIND_ICON.tool}</svg>
    </span>
  );
}
function Stock({ it }) {
  const full = Math.max(it.reorderLevel * 2, it.quantityOnHand, 1);
  return (
    <span className={'tl-stock' + (it.lowStock ? ' is-low' : '')}>
      <span className="tl-stock-row"><strong>{qtyText(it.quantityOnHand, it.unit)}</strong>{it.reorderLevel > 0 && <span className="dk-muted">{tr('reorder at {n}', { n: qtyText(it.reorderLevel) })}</span>}</span>
      <span className="tl-stock-bar" aria-hidden="true"><span style={{ width: Math.min(100, Math.round((it.quantityOnHand / full) * 100)) + '%' }} /></span>
    </span>
  );
}

const MOVE_LABELS = {
  checkout: msg('Checked out'), checkin: msg('Checked in'), issue: msg('Issued'), restock: msg('Restocked'),
  count: msg('Counted'), retire: msg('Retired'), restore: msg('Brought back')
};

export default function ToolRoomPage() {
  const { can } = useAuth();
  const canManage = can('toolroom.manage');

  const [items, setItems] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [chip, setChip] = useState('all');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState(() => readPref('bos.toolRoomView', 'cards'));

  const [detail, setDetail] = useState(null); // item id
  const [moves, setMoves] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [move, setMove] = useState(null); // { mode: out|in|issue|restock, item }
  const [moveForm, setMoveForm] = useState({});

  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importCommitting, setImportCommitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await api.get('/tool-room'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (can('employee.read')) api.get('/employees').then(setEmployees).catch(() => {});
  }, [can]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    setMoves(null);
    if (!detail) return;
    api.get('/tool-room/' + detail + '/history').then(setMoves).catch(() => setMoves([]));
  }, [detail, items]);

  const categories = useMemo(() => Array.from(new Set(items.map((it) => it.category).filter(Boolean))).sort(), [items]);
  const staff = useMemo(() => employees.filter((e) => e.status !== 'terminated' && e.status !== 'inactive'), [employees]);

  // ── actions ──────────────────────────────────────────────────────────
  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm({ ...EMPTY_FORM, category: category || '', kind: chip === 'materials' || chip === 'low' ? 'material' : 'tool' });
    setDialogOpen(true);
  }
  function openEdit(it) {
    setDialogError(null);
    setEditId(it.id);
    setForm({
      code: it.code, name: it.name, kind: it.kind, category: it.category || '', unit: it.unit,
      quantityOnHand: it.quantityOnHand, reorderLevel: it.reorderLevel, condition: it.condition,
      location: it.location, notes: it.notes || ''
    });
    setDetail(null);
    setDialogOpen(true);
  }
  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.put('/tool-room/' + editId, form);
      else await api.post('/tool-room', form);
      setToast(editId ? tr('Item updated.') : tr('Item added.'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  function openMove(it, mode) {
    setDialogError(null);
    setMoveForm(mode === 'out' ? { employeeId: '', dueBack: inDays(7), note: '' }
      : mode === 'in' ? { condition: it.condition === 'under_repair' ? 'good' : it.condition, note: '' }
        : { quantity: '', employeeId: '', note: '' });
    setDetail(null);
    setMove({ mode, item: it });
  }
  async function saveMove(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    const { mode, item } = move;
    try {
      const path = { out: 'check-out', in: 'check-in', issue: 'issue', restock: 'restock' }[mode];
      await api.post('/tool-room/' + item.id + '/' + path, moveForm);
      setToast({
        out: tr('{name} checked out.', { name: item.name }),
        in: tr('{name} checked in.', { name: item.name }),
        issue: tr('Issued {qty} of {name}.', { qty: qtyText(moveForm.quantity, item.unit), name: item.name }),
        restock: tr('Added {qty} of {name}.', { qty: qtyText(moveForm.quantity, item.unit), name: item.name })
      }[mode]);
      setMove(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function setRetired(it, retired) {
    try {
      await api.post('/tool-room/' + it.id + '/' + (retired ? 'retire' : 'restore'), {});
      setToast(retired ? tr('{name} retired.', { name: it.name }) : tr('{name} is back in the tool room.', { name: it.name }));
      await load();
    } catch (err) { setError(err.message); }
  }

  function openImport() {
    setImportError(null);
    setImportFile(null);
    setImportPreview(null);
    setImportOpen(true);
  }
  async function runImportPreview() {
    if (!importFile) return;
    setImportLoading(true);
    setImportError(null);
    setImportPreview(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      setImportPreview(await api.upload('/tool-room/import/preview', fd));
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportLoading(false);
    }
  }
  async function commitImport() {
    setImportCommitting(true);
    setImportError(null);
    try {
      const result = await api.post('/tool-room/import/commit', { rows: importPreview.rows });
      setToast(result.skipped
        ? tr('Imported {n} item(s) ({skipped} already existed, skipped).', { n: result.created, skipped: result.skipped })
        : tr('Imported {n} item(s).', { n: result.created }));
      setImportOpen(false);
      await load();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const active = items.filter((it) => it.status !== 'retired');
  const tools = active.filter((it) => !isMaterial(it));
  const materials = active.filter(isMaterial);
  const out = tools.filter((it) => it.status === 'checked_out');
  const overdue = out.filter((it) => it.overdue).sort((x, y) => String(x.dueBack).localeCompare(String(y.dueBack)));
  const longOut = out.filter((it) => !it.dueBack && it.daysOut >= LONG_OUT);
  const low = materials.filter((it) => it.lowStock).sort((x, y) => x.quantityOnHand / Math.max(x.reorderLevel, 1) - y.quantityOnHand / Math.max(y.reorderLevel, 1));
  const runningOut = materials.filter((it) => !it.lowStock && daysLeft(it) !== null && daysLeft(it) <= 14).sort((x, y) => daysLeft(x) - daysLeft(y));
  const repair = active.filter(needsRepair);
  const used30 = materials.filter((it) => it.used30 > 0).length;

  const holders = [];
  out.forEach((it) => {
    let h = holders.find((x) => x.id === it.checkedOutTo);
    if (!h) { h = { id: it.checkedOutTo, name: it.checkedOutToName, photo: it.checkedOutToPhoto, phone: it.checkedOutToPhone, items: [] }; holders.push(h); }
    h.items.push(it);
  });
  holders.forEach((h) => { h.late = h.items.filter((it) => it.overdue).length; });
  holders.sort((x, y) => y.late - x.late || y.items.length - x.items.length || String(x.name).localeCompare(String(y.name)));
  const heavy = holders.filter((h) => h.items.length >= 3);

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('tl-list'); }
  const stats = [
    { icon: 'drawer', value: String(tools.length - out.length), label: tr('tools on the shelf'), note: materials.length === 1 ? tr('and 1 material') : tr('and {n} materials', { n: materials.length }), onClick: () => { setChip('all'); jump('tl-list'); } },
    { icon: 'people', value: String(out.length), label: tr('checked out'), note: overdue.length ? tr('{n} late back', { n: overdue.length }) : out.length ? tr('none late') : tr('everything is in'), tone: overdue.length ? 'bad' : '', onClick: () => showOnly(overdue.length ? 'overdue' : 'out') },
    { icon: 'warn', value: String(low.length), label: tr('materials running low'), note: runningOut.length ? tr('{n} more run out within 2 weeks', { n: runningOut.length }) : used30 === 1 ? tr('1 used this month') : tr('{n} used this month', { n: used30 }), tone: low.length ? 'alert' : '', onClick: () => showOnly('low') },
    { icon: 'clock', value: String(repair.length), label: tr('need repair'), note: tr('poor or under repair'), tone: repair.length ? 'alert' : '', onClick: () => showOnly('repair') }
  ];

  const insights = [];
  if (overdue.length) {
    const it = overdue[0];
    insights.push({
      tone: 'bad', icon: 'clock',
      text: overdue.length === 1
        ? tr('{name} was due back from {who} on {date}.', { name: it.name, who: it.checkedOutToName, date: fmtDate(it.dueBack) })
        : tr('{n} items are late back; the oldest is {name}, with {who} since {date}.', { n: overdue.length, name: it.name, who: it.checkedOutToName, date: fmtDate(it.dueBack) }),
      action: overdue.length === 1 && canManage ? { label: tr('Check it in'), run: () => openMove(it, 'in') } : { label: tr('Show them'), run: () => showOnly('overdue') }
    });
  }
  if (low.length) {
    const it = low[0];
    insights.push({
      tone: 'warn', icon: 'warn',
      text: low.length === 1
        ? tr('{name} is down to {qty}; reorder at {level}.', { name: it.name, qty: qtyText(it.quantityOnHand, it.unit), level: qtyText(it.reorderLevel) })
        : tr('{n} materials are at or below their reorder level; {name} has {qty} left.', { n: low.length, name: it.name, qty: qtyText(it.quantityOnHand, it.unit) }),
      action: low.length === 1 && canManage ? { label: tr('Restock'), run: () => openMove(it, 'restock') } : { label: tr('Show them'), run: () => showOnly('low') }
    });
  }
  if (runningOut.length) {
    const it = runningOut[0];
    const d = daysLeft(it);
    insights.push({ tone: 'info', icon: 'calendar', text: d === 1 ? tr('At the rate it is used, {name} runs out in about 1 day.', { name: it.name }) : tr('At the rate it is used, {name} runs out in about {n} days.', { name: it.name, n: d }), action: { label: tr('Open it'), run: () => setDetail(it.id) } });
  }
  if (longOut.length) insights.push({ tone: 'info', icon: 'people', text: longOut.length === 1 ? tr('{name} has been with {who} for {n} days with no day to bring it back.', { name: longOut[0].name, who: longOut[0].checkedOutToName, n: longOut[0].daysOut }) : tr('{n} items have been out more than two weeks with no day to bring them back.', { n: longOut.length }), action: { label: tr('Show them'), run: () => showOnly('out') } });
  if (heavy.length) insights.push({ tone: 'info', icon: 'people', text: tr('{who} has {n} items checked out.', { who: heavy[0].name, n: heavy[0].items.length }), action: { label: tr('Show who has what'), run: () => jump('tl-who') } });
  if (repair.length) insights.push({ tone: 'warn', icon: 'warn', text: repair.length === 1 ? tr('{name} is in poor condition or under repair.', { name: repair[0].name }) : tr('{n} items are in poor condition or under repair.', { n: repair.length }), action: { label: tr('Show them'), run: () => showOnly('repair') } });
  if (!insights.length && active.length) insights.push({ tone: 'good', icon: 'check', text: tr('Everything that went out came back on time, and no material is low.') });

  const chipTest = {
    all: (it) => it.status !== 'retired',
    tools: (it) => it.status !== 'retired' && !isMaterial(it),
    materials: (it) => it.status !== 'retired' && isMaterial(it),
    out: (it) => it.status === 'checked_out',
    overdue: (it) => it.status === 'checked_out' && it.overdue,
    low: (it) => it.status !== 'retired' && it.lowStock,
    repair: needsRepair,
    retired: (it) => it.status === 'retired'
  };
  const visible = items.filter(chipTest[chip] || chipTest.all)
    .filter((it) => !category || it.category === category)
    .filter((it) => matchesQuery(search, it.code, it.name, it.category, it.checkedOutToName, it.location, it.notes));
  const chips = [
    ['all', tr('All'), active.length],
    ['tools', tr('Tools & equipment'), tools.length],
    ['materials', tr('Materials'), materials.length],
    ['out', tr('Checked out'), out.length],
    ['overdue', tr('Late back'), overdue.length],
    ['low', tr('Running low'), low.length],
    ['repair', tr('Need repair'), repair.length],
    ['retired', tr('Retired'), items.length - active.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  function actionsFor(it) {
    const live = it.status !== 'retired';
    return [
      { label: tr('Open'), onClick: () => setDetail(it.id) },
      canManage && live && !isMaterial(it) && it.status === 'available' && it.condition !== 'under_repair' && { label: tr('Check out'), onClick: () => openMove(it, 'out') },
      canManage && it.status === 'checked_out' && { label: tr('Check in'), onClick: () => openMove(it, 'in') },
      canManage && live && isMaterial(it) && { label: tr('Issue'), onClick: () => openMove(it, 'issue') },
      canManage && live && isMaterial(it) && { label: tr('Restock'), onClick: () => openMove(it, 'restock') },
      canManage && { label: tr('Edit'), onClick: () => openEdit(it) },
      canManage && it.status === 'available' && { label: tr('Retire'), onClick: () => setRetired(it, true), danger: true },
      canManage && it.status === 'retired' && { label: tr('Bring back'), onClick: () => setRetired(it, false) }
    ].filter(Boolean);
  }
  function mainAction(it) {
    if (!canManage || it.status === 'retired') return null;
    if (it.status === 'checked_out') return <button type="button" className="btn btn-secondary tl-btn" onClick={() => openMove(it, 'in')}>{tr('Check in')}</button>;
    if (isMaterial(it)) return <button type="button" className="btn btn-secondary tl-btn" onClick={() => openMove(it, 'issue')}>{tr('Issue')}</button>;
    if (it.condition === 'under_repair') return null;
    return <button type="button" className="btn btn-secondary tl-btn" onClick={() => openMove(it, 'out')}>{tr('Check out')}</button>;
  }
  function stateOf(it) {
    if (it.status === 'retired') return <Status tone="muted">{tr('Retired')}</Status>;
    if (it.status === 'checked_out') { const o = outText(it); return <Status tone={o.tone}>{o.text}</Status>; }
    if (isMaterial(it)) return it.lowStock ? <Status tone="warn">{tr('Running low')}</Status> : null;
    return <Status tone="good">{tr('On the shelf')}</Status>;
  }

  const cur = detail ? items.find((it) => it.id === detail) : null;
  const pick = move ? items.find((it) => it.id === move.item.id) || move.item : null;

  return (
    <div className="dk tl">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Tool room')}
        sub={tr('Tools and equipment people take out and bring back, and the materials the tool room hands out. See who has what, what is late back and what is running low. Press a number to show only those.')}
        actions={canManage && (
          <>
            <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Add item')}</button>
            <button type="button" className="btn btn-secondary" onClick={openImport}>{tr('Import from sheet')}</button>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      {holders.length > 0 && (
        <Section id="tl-who" title={tr('Who has what')} sub={tr('Everything checked out, by person; anyone with something late comes first.')}>
          <div className="tl-holders">
            {holders.map((h) => (
              <article key={h.id || 'none'} className={'tl-holder' + (h.late ? ' is-late' : '')}>
                <div className="tl-holder-head">
                  <Photo id={h.id} name={h.name} photo={h.photo} size={36} />
                  <span className="tl-holder-name">
                    <strong>{h.name || tr('Someone no longer listed')}</strong>
                    <span className="dk-muted tl-small">{h.items.length === 1 ? tr('1 item') : tr('{n} items', { n: h.items.length })}{h.late ? ' · ' + tr('{n} late', { n: h.late }) : ''}</span>
                  </span>
                  <ContactButtons name={h.name} phone={h.phone} />
                </div>
                <ul className="tl-holder-items">
                  {h.items.map((it) => {
                    const o = outText(it);
                    return (
                      <li key={it.id}>
                        <button type="button" className="tl-link" onClick={() => setDetail(it.id)}>{it.name}</button>
                        <Status tone={o.tone}>{o.text}</Status>
                      </li>
                    );
                  })}
                </ul>
              </article>
            ))}
          </div>
        </Section>
      )}

      <Section id="tl-list" title={tr('Items')} sub={tr('Press an item for everything that happened to it.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.toolRoomView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools">
          <div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search tools, equipment, materials…')} /></div>
          {categories.length > 1 && (
            <select className="input tl-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
              <option value="">{tr('All categories')}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{items.length ? tr('Nothing matches. Try another search or filter.') : tr('No tool room items yet')}</p>
            {canManage && !items.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Add item')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((it) => (
              <article key={it.id} className={'tl-card st-' + it.status + (it.overdue ? ' st-late' : '') + (it.lowStock ? ' st-low' : '')}>
                <button type="button" className="tl-card-open" onClick={() => setDetail(it.id)}>
                  <Badge it={it} />
                  <span className="tl-card-head">
                    <span className="dk-muted tl-small">{it.code} · {tr(KIND_LABELS[it.kind])}{it.category ? ' · ' + it.category : ''}</span>
                    <span className="tl-name">{it.name}</span>
                  </span>
                </button>
                <span className="tl-menu"><RowMenu actions={actionsFor(it)} /></span>
                {(stateOf(it) || showCondition(it)) && (
                  <div className="tl-tags">
                    {stateOf(it)}
                    {showCondition(it) && <span className={'tl-cond is-' + it.condition}>{conditionLabel(it.condition)}</span>}
                  </div>
                )}
                {isMaterial(it) ? (
                  <Stock it={it} />
                ) : it.status === 'checked_out' ? (
                  <div className="tl-who">
                    <Photo id={it.checkedOutTo} name={it.checkedOutToName} photo={it.checkedOutToPhoto} size={26} />
                    <span>{it.checkedOutToName}</span>
                  </div>
                ) : (
                  <div className="tl-who dk-muted"><span className="tl-place" aria-hidden="true">⌂</span><span>{it.location}</span></div>
                )}
                <div className="tl-foot">
                  <span className="dk-muted tl-small">
                    {isMaterial(it)
                      ? (it.used30 ? tr('{qty} used in 30 days', { qty: qtyText(it.used30, it.unit) }) : tr('none used in 30 days'))
                      : (it.timesOut ? (it.timesOut === 1 ? tr('Taken out once') : tr('Taken out {n} times', { n: it.timesOut })) : tr('Never taken out'))}
                  </span>
                  {mainAction(it)}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Item')}</th><th>{tr('Where it is')}</th><th>{tr('Condition')}</th><th className="is-num">{tr('On hand')}</th><th /></tr></thead>
              <tbody>
                {visible.map((it) => (
                  <tr key={it.id} className={'st-' + it.status}>
                    <td><button type="button" className="tl-row-open" onClick={() => setDetail(it.id)}><Badge it={it} size={32} /><span><span className="tl-name">{it.name}</span><span className="dk-muted tl-small">{it.code} · {tr(KIND_LABELS[it.kind])}{it.category ? ' · ' + it.category : ''}</span></span></button></td>
                    <td>{it.status === 'checked_out' ? <span className="tl-cell-stack"><span>{it.checkedOutToName}</span>{stateOf(it)}</span> : it.status === 'retired' ? stateOf(it) : it.location}</td>
                    <td>{it.status !== 'retired' ? <span className={'tl-cond is-' + it.condition}>{conditionLabel(it.condition)}</span> : '—'}</td>
                    <td className="is-num">{isMaterial(it) ? <span className={it.lowStock ? 'tl-low' : ''}>{qtyText(it.quantityOnHand, it.unit)}</span> : '—'}</td>
                    <td className="tl-menu-cell"><RowMenu actions={actionsFor(it)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Check out / check in'), tr('A tool or piece of equipment going out with someone, with the day it should come back, and coming back in, with the condition it came back in.')],
        [tr('Late back'), tr('Checked out and not back by the day it was due.')],
        [tr('Issue'), tr('Handing out a material. It comes off the quantity on the shelf and is not expected back.')],
        [tr('Reorder level'), tr('When a material gets down to this, it is running low and it is time to buy more.')],
        [tr('Runs out in'), tr('How long what is left lasts at the rate it was used over the last 30 days.')],
        [tr('Retired'), tr('No longer used: lost, broken beyond repair or used up. Its history is kept.')]
      ]} />

      {/* ── one item ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Badge it={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{cur.code} · {tr(KIND_LABELS[cur.kind])}{cur.category ? ' · ' + cur.category : ''}</span>
                <h2>{cur.name}</h2>
                <div className="tl-tags">
                  {stateOf(cur)}
                  {showCondition(cur) && <span className={'tl-cond is-' + cur.condition}>{conditionLabel(cur.condition)}</span>}
                </div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            {cur.status === 'checked_out' && (
              <div className="tl-holder is-inline">
                <div className="tl-holder-head">
                  <Photo id={cur.checkedOutTo} name={cur.checkedOutToName} photo={cur.checkedOutToPhoto} size={36} />
                  <span className="tl-holder-name">
                    <strong>{cur.checkedOutToName}</strong>
                    <span className="dk-muted tl-small">{tr('has it since {date}', { date: fmtDate(cur.checkedOutAt) })}{cur.dueBack ? ' · ' + tr('due back {date}', { date: fmtDate(cur.dueBack) }) : ''}</span>
                  </span>
                  <ContactButtons name={cur.checkedOutToName} phone={cur.checkedOutToPhone} />
                </div>
              </div>
            )}
            {isMaterial(cur) && <Stock it={cur} />}
            <dl className="tl-facts">
              <div><dt>{tr('Kept at')}</dt><dd>{cur.location || '—'}</dd></div>
              {isMaterial(cur) ? (
                <>
                  <div><dt>{tr('Used in 30 days')}</dt><dd>{qtyText(cur.used30, cur.unit)}</dd></div>
                  <div><dt>{tr('Runs out in')}</dt><dd>{daysLeft(cur) === null ? '—' : daysLeft(cur) === 1 ? tr('about 1 day') : tr('about {n} days', { n: daysLeft(cur) })}</dd></div>
                </>
              ) : (
                <div><dt>{tr('Taken out')}</dt><dd>{cur.timesOut === 1 ? tr('once') : tr('{n} times', { n: cur.timesOut })}</dd></div>
              )}
              {cur.createdAt && <div><dt>{tr('Added')}</dt><dd>{fmtDate(cur.createdAt)}</dd></div>}
            </dl>
            {cur.notes && <p className="tl-notes">{cur.notes}</p>}
            <h3 className="tl-h3">{tr('History')}</h3>
            {moves === null ? <p className="dk-muted tl-small">{tr('Loading…')}</p> : moves.length ? (
              <ul className="tl-log">
                {moves.map((m) => {
                  const d = new Date(m.at);
                  const qty = m.quantity !== null && m.quantity !== undefined ? qtyText(m.quantity, cur.unit) : null;
                  return (
                    <li key={m.id} className={'tl-log-row is-' + m.kind}>
                      <span className="tl-date" aria-hidden="true"><strong>{d.getDate()}</strong><span>{d.toLocaleDateString(activeIntlLocale(), { month: 'short', year: '2-digit' })}</span></span>
                      <span className="tl-log-main">
                        <span className="tl-log-title">
                          {tr(MOVE_LABELS[m.kind])}
                          {m.kind === 'count' && qty ? ' · ' + qty : ''}
                          {(m.kind === 'issue' || m.kind === 'restock') && qty ? ' · ' + qty : ''}
                          {m.employeeName ? (m.kind === 'checkin' ? ' · ' + tr('from {name}', { name: m.employeeName }) : ' · ' + tr('to {name}', { name: m.employeeName })) : ''}
                        </span>
                        <span className="dk-muted tl-small">{[
                          m.kind === 'checkout' && m.dueBack && tr('due back {date}', { date: fmtDate(m.dueBack) }),
                          m.kind === 'checkin' && m.condition && tr('came back {condition}', { condition: conditionLabel(m.condition).toLowerCase() }),
                          m.note,
                          m.byName && tr('by {name}', { name: m.byName })
                        ].filter(Boolean).join(' · ')}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="dk-muted tl-small">{tr('Nothing recorded yet.')}</p>}
            <div className="dialog-actions tl-actions">
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => openEdit(cur)}>{tr('Edit')}</button>}
              {canManage && cur.status !== 'retired' && isMaterial(cur) && <button type="button" className="btn btn-secondary" onClick={() => openMove(cur, 'restock')}>{tr('Restock')}</button>}
              {canManage && cur.status !== 'retired' && isMaterial(cur) && <button type="button" className="btn btn-primary" onClick={() => openMove(cur, 'issue')}>{tr('Issue')}</button>}
              {canManage && cur.status === 'checked_out' && <button type="button" className="btn btn-primary" onClick={() => openMove(cur, 'in')}>{tr('Check in')}</button>}
              {canManage && cur.status === 'available' && !isMaterial(cur) && cur.condition !== 'under_repair' && <button type="button" className="btn btn-primary" onClick={() => openMove(cur, 'out')}>{tr('Check out')}</button>}
              {!canManage && <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── check out / in, issue, restock ── */}
      {move && pick && (
        <div className="dialog-backdrop" onClick={() => !saving && setMove(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveMove}>
            <h2>{{ out: tr('Check out {name}', { name: pick.name }), in: tr('Check in {name}', { name: pick.name }), issue: tr('Issue {name}', { name: pick.name }), restock: tr('Restock {name}', { name: pick.name }) }[move.mode]}</h2>
            {(move.mode === 'issue' || move.mode === 'restock') && <p className="dk-muted tl-small">{tr('{qty} on the shelf now.', { qty: qtyText(pick.quantityOnHand, pick.unit) })}</p>}
            {move.mode === 'in' && <p className="dk-muted tl-small">{tr('With {name} since {date}.', { name: pick.checkedOutToName, date: fmtDate(pick.checkedOutAt) })}</p>}
            <div className="tl-form">
              {(move.mode === 'issue' || move.mode === 'restock') && (
                <div className="field">
                  <label htmlFor="tl-qty">{move.mode === 'issue' ? tr('How much is going out') : tr('How much came in')}{pick.unit !== 'each' ? ' (' + pick.unit + ')' : ''}</label>
                  <input id="tl-qty" className="input" type="number" min="0" step="any" max={move.mode === 'issue' ? pick.quantityOnHand : undefined} value={moveForm.quantity} onChange={(e) => setMoveForm({ ...moveForm, quantity: e.target.value })} required autoFocus />
                </div>
              )}
              {(move.mode === 'out' || move.mode === 'issue') && (
                <div className={'field' + (move.mode === 'out' ? ' tl-span' : '')}>
                  <label htmlFor="tl-emp">{move.mode === 'out' ? tr('Who is taking it') : tr('Who it is for (optional)')}</label>
                  <select id="tl-emp" className="input" value={moveForm.employeeId} onChange={(e) => setMoveForm({ ...moveForm, employeeId: e.target.value })} required={move.mode === 'out'}>
                    <option value="" disabled={move.mode === 'out'}>{move.mode === 'out' ? tr('Select an employee…') : tr('Nobody in particular')}</option>
                    {staff.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
                  </select>
                </div>
              )}
              {move.mode === 'out' && (
                <div className="field tl-span">
                  <label htmlFor="tl-due">{tr('Due back (optional)')}</label>
                  <div className="tl-due">
                    {[[0, tr('Today')], [1, tr('Tomorrow')], [7, tr('In a week')]].map(([n, label]) => (
                      <button key={n} type="button" className={'tl-seg-btn' + (moveForm.dueBack === inDays(n) ? ' is-on' : '')} onClick={() => setMoveForm({ ...moveForm, dueBack: inDays(n) })}>{label}</button>
                    ))}
                    <input id="tl-due" className="input" type="date" min={inDays(0)} value={moveForm.dueBack} onChange={(e) => setMoveForm({ ...moveForm, dueBack: e.target.value })} />
                  </div>
                </div>
              )}
              {move.mode === 'in' && (
                <div className="field tl-span">
                  <span className="tl-label">{tr('What condition did it come back in?')}</span>
                  <div className="tl-seg" role="radiogroup" aria-label={tr('Condition')}>
                    {CONDITIONS.map((c) => <button key={c.key} type="button" role="radio" aria-checked={moveForm.condition === c.key} className={'tl-seg-btn is-' + c.key + (moveForm.condition === c.key ? ' is-on' : '')} onClick={() => setMoveForm({ ...moveForm, condition: c.key })}>{tr(c.label)}</button>)}
                  </div>
                </div>
              )}
              <div className="field tl-span">
                <label htmlFor="tl-note">{tr('Note (optional)')}</label>
                <input id="tl-note" className="input" maxLength={300} value={moveForm.note} onChange={(e) => setMoveForm({ ...moveForm, note: e.target.value })}
                  placeholder={{ out: tr('What it is for, which job…'), in: tr('Anything wrong with it…'), issue: tr('Which job it is for…'), restock: tr('Where it came from…') }[move.mode]} />
              </div>
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setMove(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : { out: tr('Check out'), in: tr('Check in'), issue: tr('Issue'), restock: tr('Restock') }[move.mode]}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── add / edit ── */}
      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialogOpen(false)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editId ? tr('Edit item') : tr('Add item')}</h2>
            {!editId && (
              <div className="tl-seg" role="radiogroup" aria-label={tr('Kind')}>
                {['tool', 'equipment', 'material'].map((k) => <button key={k} type="button" role="radio" aria-checked={form.kind === k} className={'tl-seg-btn' + (form.kind === k ? ' is-on' : '')} onClick={() => setForm({ ...form, kind: k })}>{tr(KIND_LABELS[k])}</button>)}
              </div>
            )}
            <div className="tl-form">
              <div className="field">
                <label htmlFor="tr-code">{tr('Code')}</label>
                <input id="tr-code" className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} disabled={!!editId} placeholder="TR-001" maxLength={30} required />
              </div>
              <div className="field">
                <label htmlFor="tr-name">{tr('Name')}</label>
                <input id="tr-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} required />
              </div>
              <div className="field">
                <label htmlFor="tr-category">{tr('Category')}</label>
                <input id="tr-category" className="input" list="tl-categories" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder={tr('Power tools, Fasteners…')} maxLength={60} />
                <datalist id="tl-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="tr-location">{tr('Location')}</label>
                <input id="tr-location" className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} maxLength={100} />
              </div>
              {form.kind === 'material' && (
                <>
                  <div className="field">
                    <label htmlFor="tr-unit">{tr('Unit')}</label>
                    <input id="tr-unit" className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder={tr('each, litre, box…')} maxLength={20} />
                  </div>
                  <div className="field">
                    <label htmlFor="tr-qty">{tr('Quantity on hand')}</label>
                    <input id="tr-qty" className="input" type="number" min="0" step="any" value={form.quantityOnHand} onChange={(e) => setForm({ ...form, quantityOnHand: e.target.value })} required />
                    {editId && <span className="dk-muted tl-small">{tr('Changing it is recorded as a new count.')}</span>}
                  </div>
                  <div className="field">
                    <label htmlFor="tr-reorder">{tr('Reorder level')}</label>
                    <input id="tr-reorder" className="input" type="number" min="0" step="any" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
                  </div>
                </>
              )}
              <div className="field tl-span">
                <span className="tl-label">{tr('Condition')}</span>
                <div className="tl-seg" role="radiogroup" aria-label={tr('Condition')}>
                  {CONDITIONS.map((c) => <button key={c.key} type="button" role="radio" aria-checked={form.condition === c.key} className={'tl-seg-btn is-' + c.key + (form.condition === c.key ? ' is-on' : '')} onClick={() => setForm({ ...form, condition: c.key })}>{tr(c.label)}</button>)}
                </div>
              </div>
              <div className="field tl-span">
                <label htmlFor="tr-notes">{tr('Notes (optional)')}</label>
                <textarea id="tr-notes" className="input tl-textarea" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={1000} />
              </div>
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : editId ? tr('Save changes') : tr('Add item')}</button>
            </div>
          </form>
        </div>
      )}

      {importOpen && (
        <div className="dialog-backdrop" onClick={() => setImportOpen(false)}>
          <div className="dialog toolroom-import-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="toolroom-dialog-title">{tr('Import from tool room sheet')}</h2>
            <p className="dialog-body">
              {tr('Export the sheet as CSV (File → Download → Comma-separated values) and upload it here. Rows without a code get one generated automatically; rows whose code already exists are skipped, not overwritten.')}
            </p>
            {importError && <div className="error-banner">{importError}</div>}

            {!importPreview && (
              <>
                <div className="field">
                  <label htmlFor="tr-import-file">{tr('CSV file')}</label>
                  <input id="tr-import-file" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files[0] || null)} />
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={!importFile || importLoading} onClick={runImportPreview}>
                    {importLoading ? tr('Reading…') : tr('Preview import')}
                  </button>
                </div>
              </>
            )}

            {importPreview && (
              <>
                <p className="toolroom-import-summary">
                  {tr('{n} item row(s) found — {n2} will be created, {n3} already exist and will be skipped.', { n: importPreview.rows.length, n2: importPreview.rows.filter((r) => !r.willSkip).length, n3: importPreview.rows.filter((r) => r.willSkip).length })}
                </p>
                <div className="toolroom-import-scroll">
                  <table className="table toolroom-import-table">
                    <thead>
                      <tr><th>{tr('Code')}</th><th>{tr('Name')}</th><th>{tr('Kind')}</th><th>{tr('Qty')}</th><th>{tr('Condition')}</th><th>{tr('Notes')}</th></tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((r, i) => (
                        <tr key={i} className={r.willSkip ? 'toolroom-import-row-skip' : ''}>
                          <td style={{ fontWeight: 600 }}>{r.code}</td>
                          <td>{r.name}</td>
                          <td>{tr(KIND_LABELS[r.kind])}</td>
                          <td>{r.quantityOnHand}{r.unit !== 'each' ? ' ' + r.unit : ''}</td>
                          <td>{codeLabel(r.condition)}</td>
                          <td className="toolroom-import-warnings">
                            {r.willSkip && <div>{tr('Already exists — will be skipped.')}</div>}
                            {r.warnings.map((w, wi) => <div key={wi}>{w}</div>)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportPreview(null)}>{tr('Back')}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={importCommitting} onClick={commitImport}>
                    {importCommitting ? tr('Importing…') : tr('Import {n} item(s)', { n: importPreview.rows.filter((r) => !r.willSkip).length })}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
