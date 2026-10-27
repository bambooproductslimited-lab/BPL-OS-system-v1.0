import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';

// The jobs page (online.bplghana.com/jobs; backend recruitment.service.js
// publicList, publicJob, apply): the open jobs at Bamboo Products and its
// sister companies; each with what it is and who we look for, and a form to
// apply with a CV (a PDF, a Word document or a photo).

const KIND = { full_time: msg('Full time'), part_time: msg('Part time'), contract: msg('Contract'), internship: msg('Internship'), casual: msg('Casual') };
const MAX = 3500 * 1024;
function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''; }
function readFile(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
}

function Apply({ job }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', note: '', website: '' });
  const [cv, setCv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  async function pick(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > MAX) { setError(tr('That CV is too big (3.5 MB at most).')); return; }
    setError(null);
    setCv({ name: file.name, data: await readFile(file) });
  }
  async function send(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post('/jobs/' + job.slug + '/apply', { ...f, cv: cv && cv.data, cvName: cv && cv.name }); setDone(true); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  if (done) return <div className="jb-ok" role="status">🎉 {tr('Thank you, {name}. We have your application for {title} and will be in touch if you are shortlisted.', { name: f.name.split(' ')[0], title: job.title })}</div>;
  return (
    <form className="jb-form" onSubmit={send}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{tr('Apply')}</h2>
      <label>{tr('Full name')}<input required autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>{tr('Email')}<input type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <label>{tr('Phone')}<input type="tel" required autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label>{tr('Anything you would like to tell us (optional)')}<textarea rows={4} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      <label>{tr('Your CV: a PDF, a Word document or a photo')}<input type="file" required accept=".pdf,.doc,.docx,image/*" onChange={pick} /></label>
      <label className="jb-trap" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></label>
      {error && <div className="jb-err" role="alert">{error}</div>}
      <button type="submit" className="jb-btn" disabled={busy}>{busy ? tr('Sending…') : tr('Send my application')}</button>
    </form>
  );
}

export default function JobsPage() {
  const { slug } = useParams();
  const [list, setList] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setError(null);
    if (slug) api.get('/jobs/' + slug).then(setJob).catch((e) => setError(e.message));
    else api.get('/jobs').then((d) => setList(d.jobs)).catch((e) => setError(e.message));
  }, [slug]);
  return (
    <div className="jb">
      <div className="jb-wrap">
        {slug ? (
          <>
            <Link className="jb-back" to="/jobs">← {tr('All jobs')}</Link>
            {error && <div className="jb-err">{error}</div>}
            {!job && !error && <p>{tr('Loading…')}</p>}
            {job && (
              <>
                <header className="jb-head"><h1>{job.title}</h1><p>{job.company}{job.department ? ' · ' + job.department : ''}</p></header>
                <div className="jb-tags"><span>{tr(KIND[job.kind])}</span>{job.location && <span>📍 {job.location}</span>}{job.pay && <span>💰 {job.pay}</span>}{job.closesOn && <span>⏳ {tr('Apply by {date}', { date: dayText(job.closesOn) })}</span>}</div>
                <div className="jb-card"><h2>{tr('The job')}</h2><p className="jb-text">{job.description}</p></div>
                {job.requirements && <div className="jb-card"><h2>{tr('Who we are looking for')}</h2><p className="jb-text">{job.requirements}</p></div>}
                <div className="jb-card">{job.open ? <Apply job={job} /> : <p>{tr('Applications for this job are closed.')}</p>}</div>
              </>
            )}
          </>
        ) : (
          <>
            <header className="jb-head"><h1>🎋 {tr('Work with us')}</h1><p>{tr('Open jobs at Bamboo Products and its sister companies.')}</p></header>
            {error && <div className="jb-err">{error}</div>}
            {!list && !error && <p>{tr('Loading…')}</p>}
            {list && !list.length && <div className="jb-card"><p className="jb-text">{tr('No open jobs right now. Come back soon.')}</p></div>}
            {list && list.map((j) => (
              <Link key={j.slug} className="jb-card" to={'/jobs/' + j.slug}>
                <h2>{j.title}</h2>
                <div className="jb-tags"><span>{j.company}</span><span>{tr(KIND[j.kind])}</span>{j.location && <span>📍 {j.location}</span>}{j.closesOn && <span>⏳ {tr('Apply by {date}', { date: dayText(j.closesOn) })}</span>}</div>
                <p className="jb-text" style={{ color: '#4b5b4a' }}>{j.description.length > 220 ? j.description.slice(0, 220) + '…' : j.description}</p>
              </Link>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
