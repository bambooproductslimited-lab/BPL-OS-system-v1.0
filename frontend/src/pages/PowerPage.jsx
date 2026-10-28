import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentyfirst.css';

// Power and generators (Operations → Power and generators; backend
// power.service.js, migration 0203): for the factory and each restaurant,
// the power cuts, the hours each generator ran, the fuel bought for it and
// the prepaid top-ups — what a generator hour costs, and a flag when one
// burns more than it should.

const FUEL = { diesel: msg('Diesel'), petrol: msg('Petrol'), gas: msg('Gas') };
const LOG = { outage: ['🔌', msg('Power cut')], run: ['⚙️', msg('Generator ran')], fuel: ['⛽', msg('Fuel bought')], topup: ['💡', msg('Prepaid top-up')] };

function timeText(d) { return d ? new Date(d).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function hm(d) { return new Date(d).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—'; }
function num(v, p = 1) { return v == null ? '—' : (Math.round(v * 10 ** p) / 10 ** p).toLocaleString(activeIntlLocale()); }
function today() { return new Date().toISOString().slice(0, 10); }
function nowLocal() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function iso(local) { return local ? new Date(local).toISOString() : ''; }
function since(d) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
  if (mins < 60) return tr('{m} min', { m: mins });
  const h = Math.floor(mins / 60), m = mins % 60;
  return h < 48 ? tr('{h} h {m} min', { h, m }) : tr('{n} days', { n: Math.floor(h / 24) });
}

function Dialog({ title, icon, sub, onClose, onSubmit, children, busy, error, submit, width, danger }) {
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(' + (width || 560) + 'px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="pwr-d-t" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{icon}</span><div><h2 id="pwr-d-t">{title}</h2>{sub && <p>{sub}</p>}</div></div>
        {children}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>{submit && <button type="submit" className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} disabled={busy}>{submit}</button>}</div>
      </form>
    </div>,
    document.body
  );
}
function useSend(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return { busy, error, send: async (fn) => { setBusy(true); setError(null); try { onDone(await fn()); } catch (e) { setError(e.message); setBusy(false); } } };
}

function SourcesDialog({ d, onClose, onDone }) {
  const [edit, setEdit] = useState(null);
  const s = useSend((x) => { onDone(x); setEdit(null); });
  const all = d.sites.flatMap((site) => site.generators.concat(site.meters).map((x) => ({ ...x, site: site.name })));
  function start(x, kind) {
    setEdit(x ? { id: x.id, kind: x.kind, name: x.name, kva: x.kva ?? '', fuel: x.fuel, tankLitres: x.tankLitres ?? '', expectedLph: x.expectedLph ?? '', meterNo: x.meterNo, hourMeter: x.hourMeter ?? '', active: x.active }
      : { kind, companyId: (d.companies[0] || {}).id, name: '', kva: '', fuel: 'diesel', tankLitres: '', expectedLph: '', meterNo: '', hourMeter: '', active: true });
  }
  const set = (k, v) => setEdit((x) => ({ ...x, [k]: v }));
  if (!edit) {
    return (
      <Dialog title={tr('Generators and meters')} icon="⚙️" sub={tr('What each site runs on when the grid goes, and its prepaid meters.')} onClose={onClose} onSubmit={() => {}} width={640}>
        {!all.length ? <p className="x7-muted">{tr('None yet.')}</p> : <div className="x7-list">{all.map((x) => (
          <button key={x.id} type="button" className="x7-row" onClick={() => start(x)}>
            <span className="x7-icon" aria-hidden="true">{x.kind === 'generator' ? '⚙️' : '💡'}</span>
            <span className="x7-who"><b>{x.name}</b><small>{x.site}{x.kind === 'generator' ? [x.kva ? ' · ' + x.kva + ' kVA' : '', ' · ' + tr(FUEL[x.fuel]), x.expectedLph ? ' · ' + tr('{n} L an hour', { n: x.expectedLph }) : ''].join('') : x.meterNo ? ' · ' + x.meterNo : ''}</small></span>
            <span className={'x7-pill ' + (x.active ? 'is-good' : '')}>{x.active ? tr('In use') : tr('Not in use')}</span><span />
          </button>
        ))}</div>}
        <div className="pwr-add"><button type="button" className="btn btn-secondary" onClick={() => start(null, 'generator')}>⚙️ {tr('A generator')}</button><button type="button" className="btn btn-secondary" onClick={() => start(null, 'meter')}>💡 {tr('A prepaid meter')}</button></div>
      </Dialog>
    );
  }
  return (
    <Dialog title={edit.id ? edit.name : edit.kind === 'generator' ? tr('A generator') : tr('A prepaid meter')} icon={edit.kind === 'generator' ? '⚙️' : '💡'} onClose={() => setEdit(null)} onSubmit={() => s.send(() => (edit.id ? api.patch('/power/sources/' + edit.id, edit) : api.post('/power/sources', edit)))} busy={s.busy} error={s.error} submit={tr('Save')} width={600}>
      <div className="x7-grid2">
        {!edit.id && <label><span>{tr('Site')}</span><select className="input" value={edit.companyId} onChange={(e) => set('companyId', e.target.value)}>{d.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <label><span>{tr('Name')}</span><input className="input" required autoFocus value={edit.name} onChange={(e) => set('name', e.target.value)} placeholder={edit.kind === 'generator' ? tr('e.g. Generator 1 (60 kVA)') : tr('e.g. Kitchen meter')} /></label>
      </div>
      {edit.kind === 'generator' ? (
        <>
          <div className="x7-grid3">
            <label><span>kVA</span><input className="input" type="number" min="0" step="0.5" value={edit.kva} onChange={(e) => set('kva', e.target.value)} /></label>
            <label><span>{tr('Fuel')}</span><select className="input" value={edit.fuel} onChange={(e) => set('fuel', e.target.value)}>{d.fuels.map((f) => <option key={f} value={f}>{tr(FUEL[f])}</option>)}</select></label>
            <label><span>{tr('Tank (litres)')}</span><input className="input" type="number" min="0" value={edit.tankLitres} onChange={(e) => set('tankLitres', e.target.value)} /></label>
          </div>
          <div className="x7-grid2">
            <label><span>{tr('Should burn (litres an hour)')}</span><input className="input" type="number" min="0.1" step="0.1" value={edit.expectedLph} onChange={(e) => set('expectedLph', e.target.value)} /><small>{tr('from its manual at the usual load: a quarter over it is flagged')}</small></label>
            <label><span>{tr('Hour meter now')}</span><input className="input" type="number" min="0" step="0.1" value={edit.hourMeter} onChange={(e) => set('hourMeter', e.target.value)} /></label>
          </div>
        </>
      ) : <label><span>{tr('Meter number')}</span><input className="input" value={edit.meterNo} onChange={(e) => set('meterNo', e.target.value)} /></label>}
      {edit.id && <label className="x7-check"><input type="checkbox" checked={edit.active} onChange={(e) => set('active', e.target.checked)} /><span>{tr('In use')}</span></label>}
    </Dialog>
  );
}

function OffDialog({ d, site, onClose, onDone }) {
  const [f, setF] = useState({ companyId: site ? site.id : (d.sites.find((x) => !x.off) || {}).id, at: nowLocal(), generatorId: '', note: '' });
  const s = useSend(onDone);
  const here = d.sites.find((x) => x.id === f.companyId);
  const gens = here ? here.generators.filter((g) => g.active && !g.running) : [];
  return (
    <Dialog title={tr('The power went off')} icon="🔌" sub={tr('From when the grid went, until it comes back; start the generator with it.')} onClose={onClose} onSubmit={() => s.send(() => api.post('/power/outages', { ...f, at: iso(f.at) }))} busy={s.busy} error={s.error} submit={'🔌 ' + tr('Power off')}>
      <div className="x7-grid2">
        <label><span>{tr('Site')}</span><select className="input" value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value, generatorId: '' })}>{d.sites.filter((x) => !x.off).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label><span>{tr('When')}</span><input className="input" type="datetime-local" value={f.at} max={nowLocal()} onChange={(e) => setF({ ...f, at: e.target.value })} /></label>
      </div>
      {gens.length > 0 && <div className="pwr-gens" role="radiogroup" aria-label={tr('Generator')}>
        <button type="button" role="radio" aria-checked={!f.generatorId} className={!f.generatorId ? 'is-on' : ''} onClick={() => setF({ ...f, generatorId: '' })}>🚫 {tr('No generator')}</button>
        {gens.map((g) => <button key={g.id} type="button" role="radio" aria-checked={f.generatorId === g.id} className={f.generatorId === g.id ? 'is-on' : ''} onClick={() => setF({ ...f, generatorId: g.id })}>⚙️ {g.name}</button>)}
      </div>}
      <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('e.g. ECG fault on the line, planned cut')} aria-label={tr('Note')} />
    </Dialog>
  );
}

function BackDialog({ site, onClose, onDone }) {
  const [at, setAt] = useState(nowLocal());
  const s = useSend(onDone);
  return (
    <Dialog title={tr('The power is back at {site}', { site: site.name })} icon="⚡" sub={tr('Off since {t}; the generators running there go off with it.', { t: timeText(site.off.since) })} onClose={onClose} onSubmit={() => s.send(() => api.post('/power/outages/' + site.off.id + '/end', { at: iso(at) }))} busy={s.busy} error={s.error} submit={'⚡ ' + tr('Power back')}>
      <label><span>{tr('When')}</span><input className="input" type="datetime-local" value={at} max={nowLocal()} onChange={(e) => setAt(e.target.value)} /></label>
    </Dialog>
  );
}

function RunDialog({ gen, onClose, onDone }) {
  const [f, setF] = useState(gen.running ? { at: nowLocal(), meterEnd: '' } : { way: 'now', startedAt: nowLocal(), endedAt: '', meterEnd: '', note: '' });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  if (gen.running) {
    return (
      <Dialog title={tr('{name} stopped', { name: gen.name })} icon="⏹️" sub={tr('Running since {t}.', { t: timeText(gen.running.since) })} onClose={onClose} onSubmit={() => s.send(() => api.post('/power/runs/' + gen.running.id + '/end', { at: iso(f.at), meterEnd: f.meterEnd }))} busy={s.busy} error={s.error} submit={'⏹️ ' + tr('Stopped')}>
        <div className="x7-grid2">
          <label><span>{tr('When')}</span><input className="input" type="datetime-local" value={f.at} max={nowLocal()} onChange={(e) => set('at', e.target.value)} /></label>
          <label><span>{tr('Hour meter now')}</span><input className="input" type="number" min="0" step="0.1" value={f.meterEnd} onChange={(e) => set('meterEnd', e.target.value)} placeholder={gen.hourMeter != null ? String(gen.hourMeter) : ''} /></label>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title={tr('{name} ran', { name: gen.name })} icon="⚙️" onClose={onClose} onSubmit={() => s.send(() => api.post('/power/runs', { sourceId: gen.id, startedAt: iso(f.startedAt), endedAt: f.way === 'past' ? iso(f.endedAt) : '', meterEnd: f.way === 'past' ? f.meterEnd : '', note: f.note }))} busy={s.busy} error={s.error} submit={f.way === 'now' ? '▶️ ' + tr('Start it') : tr('Save the run')}>
      <div className="x7-seg" role="tablist">{[['now', '▶️', msg('Starting now')], ['past', '🕘', msg('A run already over')]].map(([k, ic, lab]) => <button key={k} type="button" role="tab" aria-selected={f.way === k} className={f.way === k ? 'is-on' : ''} onClick={() => set('way', k)}>{ic} {tr(lab)}</button>)}</div>
      <div className="x7-grid2">
        <label><span>{tr('Started')}</span><input className="input" type="datetime-local" value={f.startedAt} max={nowLocal()} onChange={(e) => set('startedAt', e.target.value)} /></label>
        {f.way === 'past' && <label><span>{tr('Stopped')}</span><input className="input" type="datetime-local" required value={f.endedAt} max={nowLocal()} onChange={(e) => set('endedAt', e.target.value)} /></label>}
      </div>
      {f.way === 'past' && <label><span>{tr('Hour meter at the end')}</span><input className="input" type="number" min="0" step="0.1" value={f.meterEnd} onChange={(e) => set('meterEnd', e.target.value)} placeholder={gen.hourMeter != null ? String(gen.hourMeter) : ''} /><small>{tr('If it has one: the hours come from it.')}</small></label>}
      <input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={tr('Anything to add')} aria-label={tr('Note')} />
    </Dialog>
  );
}

function FuelDialog({ gen, onClose, onDone }) {
  const [f, setF] = useState({ day: today(), litres: '', cost: '', vendor: '', note: '' });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const per = Number(f.litres) > 0 && Number(f.cost) > 0 ? Number(f.cost) / Number(f.litres) : null;
  return (
    <Dialog title={tr('Fuel for {name}', { name: gen.name })} icon="⛽" sub={gen.tankLitres ? tr('The tank holds {n} litres.', { n: gen.tankLitres }) : null} onClose={onClose} onSubmit={() => s.send(() => api.post('/power/fuel', { ...f, sourceId: gen.id }))} busy={s.busy} error={s.error} submit={'⛽ ' + tr('Save the fuel')}>
      <div className="x7-grid3">
        <label><span>{tr('Litres')}</span><input className="input" type="number" min="0.1" step="0.1" required autoFocus value={f.litres} onChange={(e) => set('litres', e.target.value)} /></label>
        <label><span>{tr('Cost')}</span><input className="input" type="number" min="0" step="0.01" value={f.cost} onChange={(e) => set('cost', e.target.value)} />{per && <small>{tr('{v} a litre', { v: money(per) })}</small>}</label>
        <label><span>{tr('Day')}</span><input className="input" type="date" value={f.day} max={today()} onChange={(e) => set('day', e.target.value)} /></label>
      </div>
      <div className="x7-grid2">
        <label><span>{tr('Bought from')}</span><input className="input" value={f.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder={tr('e.g. the filling station')} /></label>
        <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
      </div>
    </Dialog>
  );
}

function TopupDialog({ meter, onClose, onDone }) {
  const [f, setF] = useState({ day: today(), amount: '', units: '', reference: '', note: '' });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog title={tr('Top up {name}', { name: meter.name })} icon="💡" sub={meter.meterNo ? tr('Meter {n}', { n: meter.meterNo }) : null} onClose={onClose} onSubmit={() => s.send(() => api.post('/power/topups', { ...f, sourceId: meter.id }))} busy={s.busy} error={s.error} submit={'💡 ' + tr('Save the top-up')}>
      <div className="x7-grid3">
        <label><span>{tr('Amount')}</span><input className="input" type="number" min="0.01" step="0.01" required autoFocus value={f.amount} onChange={(e) => set('amount', e.target.value)} /></label>
        <label><span>{tr('Units (kWh)')}</span><input className="input" type="number" min="0" step="0.1" value={f.units} onChange={(e) => set('units', e.target.value)} /></label>
        <label><span>{tr('Day')}</span><input className="input" type="date" value={f.day} max={today()} onChange={(e) => set('day', e.target.value)} /></label>
      </div>
      <div className="x7-grid2">
        <label><span>{tr('Token or reference')}</span><input className="input" value={f.reference} onChange={(e) => set('reference', e.target.value)} /></label>
        <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
      </div>
    </Dialog>
  );
}

// Thirty days of hours without power: one bar a day, against the worst day.
function OffStrip({ days }) {
  const total = days.reduce((a, x) => a + x.off, 0);
  const top = Math.max(6, ...days.map((x) => x.off));
  return (
    <div className="pwr-strip" role="img" aria-label={tr('{h} hours without power in 30 days', { h: num(total) })}>
      {days.map((x) => <i key={x.day} style={{ height: Math.max(x.off > 0 ? 10 : 3, x.off / top * 100) + '%' }} className={x.off >= 8 ? 'is-long' : x.off > 0 ? 'is-off' : ''} title={dayText(x.day) + ' · ' + tr('{h} h off', { h: num(x.off) })} />)}
    </div>
  );
}

function Gauge({ g }) {
  if (g.lph == null || !g.expectedLph) return null;
  const top = Math.max(g.lph, g.expectedLph * 1.5);
  return (
    <span className={'pwr-gauge' + (g.warn === 'high' ? ' is-bad' : '')} role="img" aria-label={tr('{a} litres an hour against {b}', { a: num(g.lph, 2), b: num(g.expectedLph, 2) })}>
      <i style={{ width: g.lph / top * 100 + '%' }} />
      <b style={{ left: g.expectedLph / top * 100 + '%' }} />
      <b className="is-over" style={{ left: g.expectedLph * 1.25 / top * 100 + '%' }} />
    </span>
  );
}

export default function PowerPage() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [site, setSite] = useState('');
  const [all, setAll] = useState(false);
  const load = useCallback(() => api.get('/power').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const done = (x) => { setD(x); setDlg(null); };
  async function remove(l) {
    if (!window.confirm(tr('Take off this entry? It was entered by mistake.'))) return;
    try { setD(await api.del('/power/' + l.kind + '/' + l.id)); } catch (e) { setError(e.message); }
  }
  const log = d.log.filter((l) => !site || l.company === site);
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>⚡ {tr('Power and generators')}</h1>
          <p>{tr('Power cuts at the factory and the restaurants, the hours each generator ran, the fuel bought for it and the prepaid electricity: what an hour of the generator costs, and a flag when one burns more than it should.')}</p>
        </div>
        {d.canManage && <div className="x7-head-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'sources' })}>⚙️ {tr('Generators and meters')}</button>
          {d.sites.some((x) => !x.off) && <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'off' })}>🔌 {tr('Power off')}</button>}
        </div>}
      </header>
      <div className="x7-tiles">
        <div className={'x7-tile ' + (s.offNow ? 'is-bad' : 'is-good')}><small>🔌 {tr('Off now')}</small><b>{s.offNow}</b><span>{s.offNow ? tr('sites on the generator or dark') : tr('every site has power')}</span></div>
        <div className={'x7-tile ' + (s.offHours > 24 ? 'is-warn' : 'is-calm')}><small>🕯️ {tr('Without power')}</small><b>{tr('{h} h', { h: num(s.offHours) })}</b><span>{s.outages === 1 ? tr('1 cut in 30 days') : tr('{n} cuts in 30 days', { n: s.outages })}</span></div>
        <div className="x7-tile is-teal"><small>⚙️ {tr('Generator hours')}</small><b>{num(s.genHours)}</b><span>{tr('30 days')}</span></div>
        <div className="x7-tile is-violet"><small>⛽ {tr('Fuel')}</small><b>{money(s.fuelCost)}</b><span>{s.costPerHour != null ? tr('{v} an hour', { v: money(s.costPerHour) }) : tr('30 days')}</span></div>
        <div className="x7-tile is-calm"><small>💡 {tr('Prepaid electricity')}</small><b>{money(s.prepaid)}</b><span>{tr('30 days')}</span></div>
        <div className={'x7-tile ' + (s.warnings ? 'is-bad' : 'is-good')}><small>🚩 {tr('Fuel to look at')}</small><b>{s.warnings}</b><span>{s.warnings ? tr('burning more than they should') : tr('all as they should')}</span></div>
      </div>
      {d.warnings.length > 0 && <div className="pwr-warns">{d.warnings.map((w) => (
        <div key={w.id} className="pwr-warn" role="status"><span aria-hidden="true">🚩</span><div><b>{w.warn === 'high' ? tr('Fuel use looks wrong: {name}', { name: w.name }) : tr('Fuel bought, no hours run: {name}', { name: w.name })}</b>
          <small>{w.site} · {w.warn === 'high' ? tr('{a} litres an hour against {b} (+{p}%): {l} L for {h} hours in 30 days. A leak, a fault, or fuel going somewhere else.', { a: num(w.lph, 2), b: num(w.expectedLph, 2), p: w.overPct, l: num(w.litres), h: num(w.hours) }) : tr('{l} litres bought in 30 days and no run logged.', { l: num(w.litres) })}</small></div></div>
      ))}</div>}
      <div className="pwr-sites">{d.sites.map((x) => (
        <article key={x.id} className={'pwr-site' + (x.off ? ' is-off' : '')}>
          <header>
            <div><b>{x.name}</b><small>{x.outages === 1 ? tr('1 cut in 30 days') : tr('{n} cuts in 30 days', { n: x.outages })} · {tr('{h} h without power', { h: num(x.offHours) })}{x.longest ? ' · ' + tr('longest {h} h', { h: num(x.longest) }) : ''}</small></div>
            {x.off ? <span className="pwr-state is-off"><i aria-hidden="true" />{tr('Off for {t}', { t: since(x.off.since) })}</span> : <span className="pwr-state is-on"><i aria-hidden="true" />{tr('Power on')}</span>}
          </header>
          <OffStrip days={x.days} />
          <div className="pwr-strip-axis"><small>{dayText(x.days[0].day)}</small><small>{tr('today')}</small></div>
          {x.generators.map((g) => (
            <div key={g.id} className={'pwr-src' + (g.running ? ' is-running' : '') + (g.warn ? ' is-warn' : '')}>
              <span className="pwr-src-icon" aria-hidden="true">⚙️</span>
              <div className="pwr-src-main">
                <b>{g.name}{g.running && <span className="x7-pill is-teal">▶️ {tr('running {t}', { t: since(g.running.since) })}</span>}</b>
                <small>{[g.kva ? g.kva + ' kVA' : null, tr(FUEL[g.fuel]), g.hourMeter != null ? tr('meter {n} h', { n: num(g.hourMeter) }) : null].filter(Boolean).join(' · ')}</small>
                <span className="pwr-figs">
                  <span><em>{num(g.hours)} h</em><small>{tr('ran')}</small></span>
                  <span><em>{num(g.litres)} L</em><small>{tr('bought')}</small></span>
                  <span className={g.warn === 'high' ? 'is-bad' : ''}><em>{g.lph != null ? num(g.lph, 2) : '—'}</em><small>{g.expectedLph ? tr('L/h, {n} expected', { n: num(g.expectedLph, 2) }) : tr('L an hour')}</small></span>
                  <span><em>{g.costPerHour != null ? money(g.costPerHour) : '—'}</em><small>{tr('an hour')}</small></span>
                </span>
                <Gauge g={g} />
              </div>
              {d.canManage && <div className="pwr-src-acts">
                <button type="button" className={'btn btn-sm ' + (g.running ? 'btn-primary' : 'btn-secondary')} onClick={() => setDlg({ k: 'run', gen: g })}>{g.running ? '⏹️ ' + tr('Stop') : '▶️ ' + tr('Run')}</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDlg({ k: 'fuel', gen: g })}>⛽ {tr('Fuel')}</button>
              </div>}
            </div>
          ))}
          {x.meters.map((m) => (
            <div key={m.id} className="pwr-src is-meter">
              <span className="pwr-src-icon" aria-hidden="true">💡</span>
              <div className="pwr-src-main">
                <b>{m.name}</b><small>{m.meterNo ? tr('Meter {n}', { n: m.meterNo }) : tr('Prepaid meter')}{m.lastDay ? ' · ' + tr('last {v} on {date}', { v: money(m.lastAmount), date: dayText(m.lastDay) }) : ''}</small>
                <span className="pwr-figs">
                  <span><em>{money(m.spent)}</em><small>{tr('30 days')}</small></span>
                  <span><em>{m.units ? num(m.units) : '—'}</em><small>kWh</small></span>
                  <span><em>{m.perUnit != null ? money(m.perUnit) : '—'}</em><small>{tr('a kWh')}</small></span>
                </span>
              </div>
              {d.canManage && <div className="pwr-src-acts"><button type="button" className="btn btn-sm btn-secondary" onClick={() => setDlg({ k: 'topup', meter: m })}>💡 {tr('Top up')}</button></div>}
            </div>
          ))}
          {!x.generators.length && !x.meters.length && <p className="x7-muted">{tr('No generator or meter here yet.')}</p>}
          {d.canManage && <footer>{x.off ? <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'back', site: x })}>⚡ {tr('Power back')}</button> : <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'off', site: x })}>🔌 {tr('Power off')}</button>}</footer>}
        </article>
      ))}</div>
      <section className="x7-card">
        <div className="pwr-log-head"><h2>🗒️ {tr('The log')}</h2>
          <select className="input pwr-filter" value={site} onChange={(e) => setSite(e.target.value)} aria-label={tr('Site')}><option value="">{tr('Every site')}</option>{d.sites.map((x) => <option key={x.id} value={x.code}>{x.name}</option>)}</select></div>
        {!log.length ? <p className="x7-muted">{tr('Nothing logged yet.')}</p> : <div className="x7-list">{log.slice(0, all ? log.length : 20).map((l) => (
          <div key={l.kind + l.id} className={'x7-row pwr-log is-' + l.kind}>
            <span className="x7-icon" aria-hidden="true">{LOG[l.kind][0]}</span>
            <span className="x7-who"><b>{l.kind === 'outage' ? tr('Power cut') + (l.hours != null ? ' · ' + tr('{h} h', { h: num(l.hours) }) : ' · ' + tr('still off')) : l.kind === 'run' ? l.source + (l.hours != null ? ' · ' + tr('{h} h', { h: num(l.hours) }) : ' · ' + tr('running')) : l.kind === 'fuel' ? l.source + ' · ' + num(l.litres) + ' L' : l.source + (l.units ? ' · ' + num(l.units) + ' kWh' : '')}</b>
              <small>{l.company} · {l.kind === 'outage' || l.kind === 'run' ? timeText(l.at) + (l.end ? ' → ' + hm(l.end) : '') : dayText(l.day)}{l.vendor ? ' · ' + l.vendor : ''}{l.reference ? ' · ' + l.reference : ''}{l.note ? ' · ' + l.note : ''}{l.by ? ' · ' + l.by : ''}</small></span>
            <span className="x7-money">{l.cost != null ? money(l.cost) : l.amount != null ? money(l.amount) : ''}</span>
            {d.canManage ? <button type="button" className="pwr-del" onClick={() => remove(l)} aria-label={tr('Take off')} title={tr('Take off')}>🗑️</button> : <span />}
          </div>
        ))}</div>}
        {!all && log.length > 20 && <button type="button" className="btn btn-secondary pwr-more" onClick={() => setAll(true)}>{tr('Show all {n}', { n: log.length })}</button>}
      </section>
      {dlg && dlg.k === 'sources' && <SourcesDialog d={d} onClose={() => setDlg(null)} onDone={(x) => setD(x)} />}
      {dlg && dlg.k === 'off' && <OffDialog d={d} site={dlg.site} onClose={() => setDlg(null)} onDone={done} />}
      {dlg && dlg.k === 'back' && <BackDialog site={dlg.site} onClose={() => setDlg(null)} onDone={done} />}
      {dlg && dlg.k === 'run' && <RunDialog gen={dlg.gen} onClose={() => setDlg(null)} onDone={done} />}
      {dlg && dlg.k === 'fuel' && <FuelDialog gen={dlg.gen} onClose={() => setDlg(null)} onDone={done} />}
      {dlg && dlg.k === 'topup' && <TopupDialog meter={dlg.meter} onClose={() => setDlg(null)} onDone={done} />}
    </div>
  );
}
