import { useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { RANGES, rangeOf, useTip } from './ranges';
import './growth.css';
import './fifth.css';

// Recipes and food cost (backend restaurantCosts). Menu and stock →
// Recipes: what goes into each dish (or each of its sizes) from the
// ingredients in stock, or a cost typed by hand for a dish with no recipe;
// its cost, food cost % and profit at today's prices. Reports → Food cost:
// the cost of what was sold, the profit and the food cost %, by dish and
// category, the ingredients used, and the menu sorted into stars,
// plowhorses, puzzles and dogs (popular or not, earning more or less than
// the average dish). One blue series; the quadrants are told apart by
// where the dish sits and its name, not by colour.

function round2(n) { return Math.round(Number(n) * 100) / 100; }
const CLASS = {
  star: ['⭐', () => tr('Star'), () => tr('Popular and earns well: keep it as it is.')],
  plowhorse: ['🐴', () => tr('Plowhorse'), () => tr('Popular, earns less: raise the price a little or make it cheaper to cook.')],
  puzzle: ['🧩', () => tr('Puzzle'), () => tr('Earns well, sells little: show it off, rename it, tell the waiters.')],
  dog: ['🐶', () => tr('Dog'), () => tr('Sells little, earns little: rework it or take it off.')]
};
const SOURCE = { recipe: () => tr('Recipe'), dish_recipe: () => tr('The dish\'s recipe'), manual: () => tr('By hand'), dish_manual: () => tr('The dish\'s cost') };
// Food cost: under 30% is good, up to 38% fine, more is high (with its words, never colour alone).
function level(p) { return p == null ? null : p <= 30 ? 'good' : p <= 38 ? 'fine' : 'high'; }
const LEVEL = { good: () => tr('good'), fine: () => tr('fine'), high: () => tr('high') };
function FoodPct({ value }) {
  const l = level(value);
  if (!l) return <span className="fc-pct is-none">—</span>;
  return <span className={'fc-pct is-' + l}><b>{value}%</b><small>{LEVEL[l]()}</small></span>;
}

// ── Menu and stock → Recipes ──
function Editor({ dish, size, ingredients, onSave, onCost, busy }) {
  const target = size || dish;
  const own = target.source === 'recipe';
  const [rows, setRows] = useState(() => (own ? target.recipe.map((l) => ({ ingredientId: l.ingredientId, qty: String(l.qty) })) : []));
  const [manual, setManual] = useState(target.manualCost != null ? String(target.manualCost) : '');
  const byId = useMemo(() => Object.fromEntries(ingredients.map((i) => [i.id, i])), [ingredients]);
  const cost = round2(rows.reduce((a, r) => a + (byId[r.ingredientId] ? byId[r.ingredientId].unitCost * Number(r.qty || 0) : 0), 0));
  const shown = rows.length ? cost : manual !== '' ? Number(manual) : null;
  const pct = shown != null && target.price > 0 ? round2(shown / target.price * 100) : null;
  const unused = ingredients.filter((i) => !rows.some((r) => r.ingredientId === i.id));
  return (
    <div className="fc-editor">
      <div className="fc-editor-rows">
        {rows.map((r, i) => {
          const g = byId[r.ingredientId];
          return (
            <div key={i} className="fc-row">
              <select className="input" value={r.ingredientId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value } : x)))} aria-label={tr('Ingredient')}>
                {[g].concat(unused).filter(Boolean).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <label className="fc-qty"><input className="input" type="number" min="0" step="0.001" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label={tr('How much')} /><span>{g ? g.unit : ''}</span></label>
              <span className="fc-line-cost">{g ? money(round2(g.unitCost * Number(r.qty || 0))) : '—'}<small>{g ? tr('{amount} a {unit}', { amount: money(g.unitCost), unit: g.unit }) : ''}</small></span>
              <button type="button" className="pos-line-x" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={tr('Remove')}>×</button>
            </div>
          );
        })}
        {unused.length > 0 && <button type="button" className="pos-link" onClick={() => setRows(rows.concat([{ ingredientId: unused[0].id, qty: '' }]))}>＋ {tr('An ingredient')}</button>}
        {!ingredients.length && <p className="dk-muted">{tr('No ingredients yet: add them, with what they cost, in the OS (Restaurants → Ingredients).')}</p>}
      </div>
      {!rows.length && (
        <label className="fc-manual"><span>{tr('Or its cost by hand (GHS)')}</span>
          <input className="input" type="number" min="0" step="0.01" value={manual} onChange={(e) => setManual(e.target.value)} placeholder={tr('e.g. a bought-in drink')} /></label>
      )}
      <div className="fc-preview">
        <div><small>{tr('Costs')}</small><strong>{shown != null ? money(shown) : '—'}</strong></div>
        <div><small>{tr('Sells for')}</small><strong>{money(target.price)}</strong></div>
        <div><small>{tr('Profit')}</small><strong>{shown != null ? money(round2(target.price - shown)) : '—'}</strong></div>
        <div><small>{tr('Food cost')}</small><FoodPct value={pct} /></div>
      </div>
      <div className="tp-pay-go">
        {!rows.length && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onCost(manual === '' ? null : Number(manual))}>{tr('Save the cost')}</button>}
        <button type="button" className="btn btn-primary" disabled={busy || rows.some((r) => !(Number(r.qty) > 0))} onClick={() => onSave(rows.map((r) => ({ ingredientId: r.ingredientId, qty: Number(r.qty) })))}>
          {rows.length ? '✓ ' + tr('Save the recipe') : own ? tr('Take the recipe off') : tr('No recipe')}
        </button>
      </div>
    </div>
  );
}

export function RecipesTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // { id, sizeId }
  function ask(extra) {
    setBusy(true);
    return posFetch('POST', '/pos/settings/costs', token, { managerPin: pin || undefined, action: 'list', ...extra }).then(setData).catch(onFail).finally(() => setBusy(false));
  }
  useEffect(() => { ask(); }, [token, pin]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <section className="ts-sec"><p className="dk-muted">{busy ? tr('Loading…') : ''}</p></section>;
  const words = q.trim().toLowerCase();
  const shown = data.dishes.filter((d) => !words || d.name.toLowerCase().includes(words) || d.category.toLowerCase().includes(words));
  const cats = [...new Set(shown.map((d) => d.category))];
  const s = data.summary;
  return (
    <section className={'ts-sec fc' + (busy ? ' is-busy' : '')}>
      <div className="fc-summary">
        <div className="fc-ring" style={{ '--p': s.dishes ? s.costed / s.dishes : 0 }} aria-hidden="true"><b>{s.costed}</b><small>/{s.dishes}</small></div>
        <div>
          <strong>{tr('{n} of {total} dishes have a cost', { n: s.costed, total: s.dishes })}</strong>
          <span className="dk-muted">{[tr('{n} with a recipe', { n: s.recipes }), s.averageFoodCost != null ? tr('average food cost {pct}%', { pct: s.averageFoodCost }) : null].filter(Boolean).join(' · ')}</span>
          <small className="dk-muted">{tr('A recipe draws its ingredients off the stock with each sale; a voided sale puts them back.')}</small>
        </div>
        <label className="on-search fc-search"><span aria-hidden="true">🔎</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a dish')} aria-label={tr('Find a dish')} /></label>
      </div>
      {cats.map((c) => (
        <div key={c} className="fc-cat">
          <h3>{c || tr('Other')}</h3>
          <ul className="fc-dishes is-plain">
            {shown.filter((d) => d.category === c).map((d) => {
              const targets = d.sizes.length ? d.sizes.map((z) => ({ ...z, sizeId: z.id, label: z.name })) : [{ ...d, sizeId: null, label: null }];
              return targets.map((t) => {
                const isOpen = open && open.id === d.id && open.sizeId === t.sizeId;
                return (
                  <li key={d.id + (t.sizeId || '')} className={isOpen ? 'is-open' : ''}>
                    <button type="button" className="fc-dish" onClick={() => setOpen(isOpen ? null : { id: d.id, sizeId: t.sizeId })} aria-expanded={isOpen}>
                      <span className="fc-dish-name"><strong>{d.name}{t.label ? ' · ' + t.label : ''}</strong>
                        <small>{t.source ? SOURCE[t.source]() + (t.recipe.length ? ' · ' + t.recipe.map((l) => l.name).join(', ') : '') : tr('No cost yet')}</small></span>
                      <span className="fc-dish-num"><small>{tr('Costs')}</small><b>{t.cost != null ? money(t.cost) : '—'}</b></span>
                      <span className="fc-dish-num"><small>{tr('Sells for')}</small><b>{money(t.price)}</b></span>
                      <FoodPct value={t.foodCost} />
                    </button>
                    {isOpen && <Editor dish={d} size={t.sizeId ? t : null} ingredients={data.ingredients} busy={busy}
                      onSave={(lines) => ask({ action: 'recipe', menuItemId: d.id, variationId: t.sizeId || undefined, lines }).then(() => setOpen(null))}
                      onCost={(unitCost) => ask({ action: 'cost', menuItemId: d.id, variationId: t.sizeId || undefined, unitCost }).then(() => setOpen(null))} />}
                  </li>
                );
              });
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

// ── Reports → Food cost ──
function Quadrant({ dishes, eng, tipOn }) {
  const pts = dishes.filter((d) => d.class);
  if (!pts.length) return <p className="dk-muted">{tr('Give your dishes a cost (Menu and stock → Recipes) to sort the menu.')}</p>;
  const W = 640, H = 340, P = { l: 56, r: 16, t: 16, b: 40 };
  const xMax = Math.max(eng.popularAt * 2, ...pts.map((d) => d.qty)) * 1.08;
  const yVals = pts.map((d) => d.unitProfit);
  const yMin = Math.min(0, ...yVals), yMax = Math.max(eng.averageProfit * 2, ...yVals) * 1.1 || 1;
  const x = (v) => P.l + (v / xMax) * (W - P.l - P.r);
  const y = (v) => H - P.b - ((v - yMin) / (yMax - yMin)) * (H - P.t - P.b);
  const labelled = new Set(pts.slice().sort((a, b) => b.revenue - a.revenue).slice(0, 5).map((d) => d.name));
  // Each quadrant's name in its own corner by the lines that divide them, clear of the axes.
  const midY = y(eng.averageProfit);
  const corner = [['puzzle', P.l + 8, P.t + 14, 'start'], ['star', W - P.r - 8, P.t + 14, 'end'], ['dog', P.l + 8, midY + 18, 'start'], ['plowhorse', W - P.r - 8, midY + 18, 'end']];
  return (
    <svg className="fc-quad" viewBox={'0 0 ' + W + ' ' + H} role="img" aria-label={tr('The menu by how much it sells and what each dish earns')}>
      <line className="fc-axis" x1={P.l} y1={H - P.b} x2={W - P.r} y2={H - P.b} />
      <line className="fc-axis" x1={P.l} y1={P.t} x2={P.l} y2={H - P.b} />
      <line className="fc-mid" x1={x(eng.popularAt)} y1={P.t} x2={x(eng.popularAt)} y2={H - P.b} />
      <line className="fc-mid" x1={P.l} y1={y(eng.averageProfit)} x2={W - P.r} y2={y(eng.averageProfit)} />
      {corner.map(([k, cx, cy, anchor]) => <text key={k} className="fc-corner" x={cx} y={cy} textAnchor={anchor}>{CLASS[k][0]} {CLASS[k][1]()}</text>)}
      <text className="fc-axis-t" x={(W + P.l) / 2} y={H - 8} textAnchor="middle">{tr('Sold →')}</text>
      <text className="fc-axis-t" x={14} y={(H - P.b + P.t) / 2} textAnchor="middle" transform={'rotate(-90 14 ' + (H - P.b + P.t) / 2 + ')'}>{tr('Profit a dish →')}</text>
      {pts.map((d) => (
        <g key={d.name} className="fc-pt" {...tipOn(d.name + ': ' + tr('{n} sold', { n: d.qty }) + ' · ' + tr('{amount} profit a dish', { amount: money(d.unitProfit) }) + ' · ' + CLASS[d.class][1]())}>
          <circle cx={x(d.qty)} cy={y(d.unitProfit)} r="7" />
          {labelled.has(d.name) && (x(d.qty) > W * 0.7
            ? <text x={x(d.qty) - 11} y={y(d.unitProfit) + 4} textAnchor="end">{d.name.length > 18 ? d.name.slice(0, 17) + '…' : d.name}</text>
            : <text x={x(d.qty) + 11} y={y(d.unitProfit) + 4}>{d.name.length > 18 ? d.name.slice(0, 17) + '…' : d.name}</text>)}
        </g>
      ))}
    </svg>
  );
}

export default function FoodCostReport({ token, pin, onFail }) {
  const [range, setRange] = useState('30');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tipOn, tipNode] = useTip();
  useEffect(() => {
    let live = true;
    setBusy(true);
    const r = rangeOf(range);
    posFetch('POST', '/pos/settings/costs', token, { managerPin: pin || undefined, action: 'report', from: r.from, to: r.to })
      .then((d) => { if (live) setData(d); }).catch(onFail).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [range, token, pin, onFail]);
  if (!data) return <section className="ts-sec"><p className="dk-muted">{busy ? tr('Loading…') : ''}</p></section>;
  const t = data.totals;
  const catMax = Math.max(1, ...data.categories.map((c) => c.revenue));
  return (
    <section className={'ts-sec in fc' + (busy ? ' is-busy' : '')}>
      <div className="in-filters">
        <div className="ts-chips" role="radiogroup" aria-label={tr('When')}>
          {RANGES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={range === k} className={range === k ? 'is-on' : ''} onClick={() => setRange(k)}>{tr(label)}</button>)}
        </div>
      </div>
      <div className="in-kpis">
        {[['💰', tr('Dish sales'), money(t.revenue)], ['🥘', tr('Cost of what was sold'), money(t.cost)], ['📈', tr('Gross profit'), money(t.profit)]].map(([art, label, value]) => (
          <div key={label} className="in-kpi"><span className="in-kpi-ico" aria-hidden="true">{art}</span><span className="in-kpi-label">{label}</span><strong>{value}</strong></div>
        ))}
        <div className="in-kpi"><span className="in-kpi-ico" aria-hidden="true">🎯</span><span className="in-kpi-label">{tr('Food cost')}</span><FoodPct value={t.foodCost} /></div>
      </div>
      {t.uncostedRevenue > 0 && <p className="ts-note">💡 {tr('{amount} of the sales ({pct}% costed) were dishes with no cost yet: give them a recipe or a cost in Menu and stock → Recipes.', { amount: money(t.uncostedRevenue), pct: t.costedShare != null ? t.costedShare : 0 })}</p>}

      <div className="in-card">
        <h3>{tr('Menu engineering')}<small>{tr('Popular: more than {n} sold · earns well: more than {amount} a dish', { n: Math.round(data.engineering.popularAt), amount: money(data.engineering.averageProfit) })}</small></h3>
        <div className="fc-quad-wrap"><Quadrant dishes={data.dishes} eng={data.engineering} tipOn={tipOn} /></div>
        <ul className="fc-classes is-plain">
          {Object.keys(CLASS).map((k) => (
            <li key={k}><span aria-hidden="true">{CLASS[k][0]}</span><div><strong>{CLASS[k][1]()} · {data.engineering.counts[k] || 0}</strong><small>{CLASS[k][2]()}</small></div></li>
          ))}
        </ul>
      </div>

      <div className="in-grid">
        <article className="in-card">
          <h3>{tr('By category')}</h3>
          <ul className="in-bars is-plain">
            {data.categories.map((c) => (
              <li key={c.category}>
                <span className="in-bar-name">{c.category || tr('Other')}</span>
                <span className="in-bar-track" {...tipOn((c.category || tr('Other')) + ': ' + money(c.revenue) + ' · ' + tr('profit {amount}', { amount: money(c.profit) }) + (c.foodCost != null ? ' · ' + tr('food cost {pct}%', { pct: c.foodCost }) : ''))}>
                  <span className="in-bar" style={{ width: Math.max(1.5, c.revenue / catMax * 100) + '%' }} /></span>
                <span className="in-bar-val">{money(c.revenue)}<small>{c.foodCost != null ? c.foodCost + '%' : '—'}</small></span>
              </li>
            ))}
          </ul>
        </article>
        <article className="in-card">
          <h3>{tr('Ingredients used')}</h3>
          {!data.ingredients.length ? <p className="dk-muted">{tr('None: no dish sold had a recipe.')}</p> : (
            <table className="ts-table"><thead><tr><th>{tr('Ingredient')}</th><th className="is-num">{tr('Used')}</th><th className="is-num">{tr('Cost')}</th></tr></thead>
              <tbody>{data.ingredients.map((g) => <tr key={g.id}><td>{g.name}</td><td className="is-num">{g.qty} {g.unit}</td><td className="is-num">{money(g.cost)}</td></tr>)}</tbody></table>
          )}
        </article>
      </div>

      <div className="in-card">
        <h3>{tr('By dish')}</h3>
        <div className="fc-table-wrap">
          <table className="ts-table fc-table">
            <thead><tr><th>{tr('Dish')}</th><th className="is-num">{tr('Sold')}</th><th className="is-num">{tr('Sales')}</th><th className="is-num">{tr('Cost')}</th><th className="is-num">{tr('Profit')}</th><th>{tr('Food cost')}</th><th>{tr('Class')}</th></tr></thead>
            <tbody>
              {data.dishes.map((d) => (
                <tr key={d.name}><td>{d.name}<small className="dk-muted"> · {d.category || tr('Other')}</small></td><td className="is-num">{d.qty}</td><td className="is-num">{money(d.revenue)}</td>
                  <td className="is-num">{d.cost != null ? money(d.cost) : '—'}</td><td className="is-num">{d.profit != null ? money(d.profit) : '—'}</td><td><FoodPct value={d.foodCost} /></td>
                  <td>{d.class ? <span className="fc-class">{CLASS[d.class][0]} {CLASS[d.class][1]()}</span> : <span className="dk-muted">—</span>}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {tipNode}
    </section>
  );
}
