import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { tr } from '../../lib/i18n.jsx';

// "How was it?" on the receipt page (backend restaurantFeedback): a face
// from 1 to 5, what stood out, the dishes liked or not, a comment, and
// whether the restaurant may get in touch. A happy guest is then shown the
// restaurant's review page; an unhappy one is told a manager will see it.
// One per visit, changeable for two weeks.

const FACES = [['😞', () => tr('Bad')], ['🙁', () => tr('Not great')], ['😐', () => tr('OK')], ['🙂', () => tr('Good')], ['😍', () => tr('Loved it')]];
const TAG = { food: ['🍲', () => tr('Food')], service: ['🙋', () => tr('Service')], speed: ['⚡', () => tr('Speed')], value: ['💰', () => tr('Value')], ambience: ['🎶', () => tr('Ambience')], cleanliness: ['✨', () => tr('Cleanliness')] };

export default function FeedbackCard({ token }) {
  const [ask, setAsk] = useState(null);
  const [rating, setRating] = useState(0);
  const [tags, setTags] = useState([]);
  const [dishes, setDishes] = useState({});
  const [comment, setComment] = useState('');
  const [contactOk, setContactOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    posFetch('GET', '/pos/receipt/' + encodeURIComponent(token) + '/feedback').then((a) => {
      setAsk(a);
      if (a.given) {
        setRating(a.given.rating); setTags(a.given.tags); setComment(a.given.comment); setContactOk(a.given.contactOk);
        setDishes(Object.fromEntries(a.given.dishes.map((d) => [d.name, d.liked])));
        setDone({ given: a.given, reviewUrl: a.reviewUrl });
      }
    }).catch(() => { /* no feedback here */ });
  }, [token]);
  if (!ask || !ask.on || (!ask.open && !ask.given)) return null;

  async function send(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/receipt/' + encodeURIComponent(token) + '/feedback', null, {
        rating, tags, comment: comment.trim(), contactOk, dishes: Object.keys(dishes).filter((k) => typeof dishes[k] === 'boolean').map((k) => ({ name: k, liked: dishes[k] }))
      });
      setDone(r); setEditing(false);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (done && !editing) {
    const g = done.given;
    return (
      <section className={'fbk is-done' + (g.rating >= 4 ? ' is-happy' : g.rating <= 2 ? ' is-sad' : '')} aria-live="polite">
        {g.rating >= 4 && <span className="fbk-burst" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ '--i': i }} />)}</span>}
        <span className="fbk-big" aria-hidden="true">{FACES[g.rating - 1][0]}</span>
        <strong>{g.rating >= 4 ? tr('Thank you, that made our day!') : g.rating <= 2 ? tr('Thank you for telling us. We are sorry.') : tr('Thank you for your feedback!')}</strong>
        <p>{g.rating <= 2 ? (g.contactOk ? tr('A manager will read this and get in touch.') : tr('A manager will read this and put it right.')) : tr('The team reads every word.')}</p>
        {done.reviewUrl && <a className="on-go fbk-review" href={done.reviewUrl} target="_blank" rel="noopener noreferrer">⭐ {tr('Share it in a review')}</a>}
        {ask.open && <button type="button" className="fbk-edit" onClick={() => setEditing(true)}>{tr('Change my answer')}</button>}
      </section>
    );
  }

  const happy = rating >= 4;
  return (
    <form className="fbk" onSubmit={send}>
      <h2>{tr('How was your visit?')}</h2>
      <div className="fbk-faces" role="radiogroup" aria-label={tr('How was your visit?')}>
        {FACES.map(([art, label], i) => (
          <button key={i} type="button" role="radio" aria-checked={rating === i + 1} className={rating === i + 1 ? 'is-on' : rating ? 'is-dim' : ''} onClick={() => setRating(i + 1)}>
            <span aria-hidden="true">{art}</span><small>{label()}</small>
          </button>
        ))}
      </div>
      {rating > 0 && (
        <div className="fbk-more">
          <span className="fbk-label">{happy ? tr('What did you love?') : rating <= 2 ? tr('What went wrong?') : tr('What could be better?')}</span>
          <div className="fbk-tags">
            {ask.tags.map((t) => {
              const on = tags.includes(t);
              return <button key={t} type="button" aria-pressed={on} className={on ? 'is-on' : ''} onClick={() => setTags(on ? tags.filter((x) => x !== t) : tags.concat([t]))}><span aria-hidden="true">{TAG[t] ? TAG[t][0] : '•'}</span>{TAG[t] ? TAG[t][1]() : t}</button>;
            })}
          </div>
          {ask.dishes.length > 0 && (
            <>
              <span className="fbk-label">{tr('Your dishes')}</span>
              <ul className="fbk-dishes is-plain">
                {ask.dishes.map((d) => (
                  <li key={d}><span>{d}</span>
                    <button type="button" aria-pressed={dishes[d] === true} aria-label={tr('Liked {dish}', { dish: d })} className={dishes[d] === true ? 'is-up' : ''} onClick={() => setDishes({ ...dishes, [d]: dishes[d] === true ? undefined : true })}>👍</button>
                    <button type="button" aria-pressed={dishes[d] === false} aria-label={tr('Did not like {dish}', { dish: d })} className={dishes[d] === false ? 'is-down' : ''} onClick={() => setDishes({ ...dishes, [d]: dishes[d] === false ? undefined : false })}>👎</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <textarea className="input" rows={3} maxLength={600} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={happy ? tr('Anything to tell the team? (optional)') : tr('Tell us what happened (optional)')} aria-label={tr('Comment')} />
          <label className="fbk-ok"><input type="checkbox" checked={contactOk} onChange={(e) => setContactOk(e.target.checked)} /><span>{tr('The restaurant may get in touch with me about this')}</span></label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button type="submit" className="on-go is-big" disabled={busy}>{busy ? tr('Sending…') : tr('Send')}</button>
          <small className="on-hint is-center">{tr('Only the restaurant sees this.')}</small>
        </div>
      )}
    </form>
  );
}
