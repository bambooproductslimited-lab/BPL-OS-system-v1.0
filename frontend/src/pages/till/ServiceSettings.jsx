import { tr } from '../../lib/i18n.jsx';
import { COURSE_WORDS, isOn } from './tillService';

// The table's service in the till settings (TillSettings.jsx, "Courses,
// menu times and happy hours"; backend restaurantTillTimes): courses (the
// later ones wait at the kitchen until the waiter calls them; each menu
// category's course), menus by time of day (a category served only
// between two times), and happy hours (a percentage off some categories on
// some days between two times). The restaurant's clock is Ghana's (GMT).

const DAYS = [[1, () => tr('Mon')], [2, () => tr('Tue')], [3, () => tr('Wed')], [4, () => tr('Thu')], [5, () => tr('Fri')], [6, () => tr('Sat')], [0, () => tr('Sun')]];
function newId() { return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'h-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function Days({ value, onChange }) {
  const days = value || [];
  return (
    <div className="ts-chips ts-days" role="group" aria-label={tr('Days')}>
      {DAYS.map(([d, label]) => {
        const on = !days.length || days.includes(d);
        return (
          <button key={d} type="button" aria-pressed={on} className={'ts-chip' + (on ? ' is-on' : '')}
            onClick={() => { const all = days.length ? days : DAYS.map((x) => x[0]); const next = on ? all.filter((x) => x !== d) : all.concat([d]); onChange(next.length === 7 ? [] : next); }}>
            {label()}
          </button>
        );
      })}
    </div>
  );
}

export default function ServiceSettings({ draft, set, categories }) {
  const courses = draft.courses || { on: false, names: ['Starters', 'Mains', 'Desserts'], categories: {} };
  const hours = (draft.hours && draft.hours.categories) || {};
  const happy = draft.happyHours || [];
  const cats = categories || [];
  const setCourse = (cat, n) => set(['courses', 'categories'], { ...courses.categories, [cat]: n });
  const setHour = (cat, w) => { const next = { ...hours }; if (w) next[cat] = w; else delete next[cat]; set(['hours', 'categories'], next); };
  const setHappy = (i, patch) => set(['happyHours'], happy.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  return (
    <section className="ts-sec ts-svc">
      <div className="ts-bill-block">
        <h3><span aria-hidden="true">🍽</span>{tr('Courses')}</h3>
        <button type="button" role="switch" aria-checked={!!courses.on} className="ts-toggle-row" onClick={() => set(['courses'], { ...courses, on: !courses.on })}>
          <span><strong>{tr('Serve in courses')}</strong><small>{tr('On an order eaten in, the first course goes to the kitchen at once; the next ones wait there until the waiter calls them from Open orders.')}</small></span>
          <span className={'ts-switch' + (courses.on ? ' is-on' : '')} aria-hidden="true"><i /></span>
        </button>
        {courses.on && (
          <>
            <div className="ts-svc-names">
              {(courses.names || []).map((n, i) => (
                <div key={i} className="ts-svc-name">
                  <b className={'is-c' + (i + 1)}>{i + 1}</b>
                  <input className="input" maxLength={30} value={n} onChange={(e) => set(['courses', 'names'], courses.names.map((x, j) => (j === i ? e.target.value : x)))} aria-label={tr('Course {n}', { n: i + 1 })}
                    placeholder={COURSE_WORDS[i] ? tr(COURSE_WORDS[i]) : tr('Course {n}', { n: i + 1 })} />
                  {courses.names.length > 1 && <button type="button" className="pos-line-x" onClick={() => set(['courses', 'names'], courses.names.filter((_, j) => j !== i))} aria-label={tr('Remove')}>×</button>}
                </div>
              ))}
              {(courses.names || []).length < 5 && <button type="button" className="btn btn-secondary tl-btn" onClick={() => set(['courses', 'names'], (courses.names || []).concat(['']))}>+ {tr('A course')}</button>}
            </div>
            <p className="dk-muted">{tr('Each menu category\'s course. "Right away" goes to the kitchen at once, whatever the course (drinks, bread). The till can change a dish\'s course.')}</p>
            <ul className="ts-svc-cats is-plain">
              {cats.map((c) => {
                const n = Number(courses.categories[c] || 0);
                return (
                  <li key={c}>
                    <span>{c}</span>
                    <div className="dk-segment" role="radiogroup" aria-label={c}>
                      <button type="button" role="radio" aria-checked={n === 0} className={n === 0 ? 'is-on' : ''} onClick={() => setCourse(c, 0)}>⚡ {tr('Right away')}</button>
                      {(courses.names || []).map((name, i) => (
                        <button key={i} type="button" role="radio" aria-checked={n === i + 1} className={n === i + 1 ? 'is-on' : ''} onClick={() => setCourse(c, i + 1)}>{name ? tr(name) : tr('Course {n}', { n: i + 1 })}</button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <div className="ts-bill-block">
        <h3><span aria-hidden="true">🕘</span>{tr('Menus by time of day')}</h3>
        <p className="dk-muted">{tr('A category served only at set times, such as breakfast. Outside them its dishes are greyed on the till and cannot be ordered on the website or at the table. Times are Ghana time.')}</p>
        <ul className="ts-svc-cats is-plain">
          {cats.map((c) => {
            const w = hours[c];
            return (
              <li key={c} className={w ? 'is-timed' : ''}>
                <label className="ts-bill-check"><input type="checkbox" checked={!!w} onChange={(e) => setHour(c, e.target.checked ? { from: '06:00', to: '11:30', days: [] } : null)} />{c}</label>
                {w ? (
                  <div className="ts-svc-times">
                    <input className="input" type="time" value={w.from} onChange={(e) => setHour(c, { ...w, from: e.target.value })} aria-label={tr('From')} />
                    <span>–</span>
                    <input className="input" type="time" value={w.to} onChange={(e) => setHour(c, { ...w, to: e.target.value })} aria-label={tr('To')} />
                    <Days value={w.days} onChange={(days) => setHour(c, { ...w, days })} />
                    <em className={isOn(w) ? 'is-on' : ''}>{isOn(w) ? tr('Served now') : tr('Not now')}</em>
                  </div>
                ) : <small className="dk-muted">{tr('All day')}</small>}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="ts-bill-block">
        <h3><span aria-hidden="true">🍹</span>{tr('Happy hours')}</h3>
        <p className="dk-muted">{tr('A percentage off some categories at set times. The till puts it on a dish added then; the website and the table\'s QR menu get it by themselves.')}</p>
        {happy.map((h, i) => (
          <div key={h.id || i} className={'ts-svc-happy' + (isOn(h) ? ' is-live' : '')}>
            <div className="ts-svc-happy-top">
              <input className="input" maxLength={40} value={h.name} onChange={(e) => setHappy(i, { name: e.target.value })} placeholder={tr('e.g. Happy hour')} aria-label={tr('Name')} />
              <input className="input ts-bill-num" type="number" min="1" max="100" step="1" value={h.percent} onChange={(e) => setHappy(i, { percent: e.target.value })} aria-label={tr('Percentage off')} />
              <span className="ts-bill-pct">% {tr('off')}</span>
              <input className="input" type="time" value={h.from} onChange={(e) => setHappy(i, { from: e.target.value })} aria-label={tr('From')} />
              <span>–</span>
              <input className="input" type="time" value={h.to} onChange={(e) => setHappy(i, { to: e.target.value })} aria-label={tr('To')} />
              {isOn(h) && <em className="ts-svc-live">● {tr('On now')}</em>}
              <button type="button" className="pos-line-x" onClick={() => set(['happyHours'], happy.filter((_, j) => j !== i))} aria-label={tr('Remove')}>×</button>
            </div>
            <Days value={h.days} onChange={(days) => setHappy(i, { days })} />
            <div className="ts-chips">
              <span className="ts-label">{tr('On')}</span>
              {cats.map((c) => {
                const on = (h.categories || []).includes(c);
                return <button key={c} type="button" aria-pressed={on} className={'ts-chip' + (on ? ' is-on' : '')} onClick={() => setHappy(i, { categories: on ? h.categories.filter((x) => x !== c) : (h.categories || []).concat([c]) })}>{c}</button>;
              })}
              {!(h.categories || []).length && <small className="dk-muted">{tr('None picked: the whole menu.')}</small>}
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-secondary tl-btn" onClick={() => set(['happyHours'], happy.concat([{ id: newId(), name: '', percent: 20, from: '17:00', to: '19:00', days: [], categories: [] }]))}>+ {tr('A happy hour')}</button>
      </div>
    </section>
  );
}
