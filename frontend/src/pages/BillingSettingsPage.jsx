import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Glossary, Hero, Insights, Section, Status, jump } from '../components/DashKit';
import { tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './BillingSettingsPage.css';

// Billing settings — the wording, dates, payment details, numbering and tax
// rates every quotation, estimate and invoice is made with. Same "explains
// itself" layout as the dashboards (components/DashKit.jsx): how long
// quotations stay valid and when invoices fall due, which ways to pay the
// invoices show, the tax rates; what stands out (no bank account or mobile
// money on invoices, no terms), then each part with a live look at how the
// payment block prints.
//
// Backed by GET/PATCH /api/commercial-settings and the tax-rate routes, all
// needing settings.manage — the same permission that shows this page in
// navModel.js. The service keeps only known fields and checks the day
// counts (1–365); a tax rate goes only when no catalogue item uses it.
// Currencies are chosen in Company settings, so they are shown here with a
// link rather than edited twice.

const EMPTY = {
  quotationIntro: '', quotationFooter: '', invoiceFooter: '', paymentTerms: '', terms: '', validityDays: '', invoiceDueDays: '',
  bankName: '', accountName: '', accountNumber: '', branch: '', swift: '', momoProvider: '', momoNumber: '', instructions: ''
};
function formFrom(s) {
  return {
    quotationIntro: s.templates.quotationIntro || '', quotationFooter: s.templates.quotationFooter || '', invoiceFooter: s.templates.invoiceFooter || '',
    paymentTerms: s.templates.paymentTerms || '', terms: s.templates.termsAndConditions || '', validityDays: String(s.templates.validityDays || ''), invoiceDueDays: String(s.templates.invoiceDueDays || ''),
    bankName: s.paymentDetails.bankName || '', accountName: s.paymentDetails.accountName || '', accountNumber: s.paymentDetails.accountNumber || '',
    branch: s.paymentDetails.branch || '', swift: s.paymentDetails.swift || '', momoProvider: s.paymentDetails.momoProvider || '',
    momoNumber: s.paymentDetails.momoNumber || '', instructions: s.paymentDetails.instructions || ''
  };
}

export default function BillingSettingsPage() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saved, setSaved] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(false);
  const [taxName, setTaxName] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [addingTax, setAddingTax] = useState(false);
  const [busyTax, setBusyTax] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.get('/commercial-settings');
      setSettings(s);
      setForm(formFrom(s));
      setSaved(formFrom(s));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.patch('/commercial-settings', {
        templates: {
          quotationIntro: form.quotationIntro, quotationFooter: form.quotationFooter, invoiceFooter: form.invoiceFooter,
          paymentTerms: form.paymentTerms, termsAndConditions: form.terms, validityDays: Number(form.validityDays), invoiceDueDays: Number(form.invoiceDueDays)
        },
        paymentDetails: {
          bankName: form.bankName, accountName: form.accountName, accountNumber: form.accountNumber, branch: form.branch,
          swift: form.swift, momoProvider: form.momoProvider, momoNumber: form.momoNumber, instructions: form.instructions
        }
      });
      setToast(tr('Billing settings saved.'));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function handleAddTaxRate(e) {
    e.preventDefault();
    setAddingTax(true);
    setError(null);
    try {
      await api.post('/commercial-settings/tax-rates', { name: taxName, rate: taxRate });
      setToast(tr('Tax rate added.'));
      setTaxName('');
      setTaxRate('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingTax(false);
    }
  }
  async function removeTax(t) {
    if (!window.confirm(tr('Remove the tax rate {name} ({rate}%)?', { name: t.name, rate: t.rate }))) return;
    setBusyTax(t.id);
    setError(null);
    try {
      await api.del('/commercial-settings/tax-rates/' + t.id);
      setToast(tr('{name} removed.', { name: t.name }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyTax(null);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (!settings) return <div className="error-banner">{error}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const dirty = Object.keys(form).some((k) => form[k] !== saved[k]);
  const hasBank = !!(saved.bankName && saved.accountNumber);
  const hasMomo = !!saved.momoNumber;
  const ways = (hasBank ? 1 : 0) + (hasMomo ? 1 : 0);
  const taxRates = settings.taxRates || [];
  const currencies = settings.currencies || ['GHS'];
  const year = new Date().getFullYear();
  const numbering = Object.keys(settings.numbering || {}).map((k) => {
    const n = settings.numbering[k];
    return { key: k, doc: codeLabel(k), next: n.prefix + '-' + (n.includeYear ? year + '-' : '') + String(n.nextNumber).padStart(n.padding, '0') };
  });

  const stats = [
    { icon: 'doc', value: tr('{n} days', { n: saved.validityDays || '—' }), label: tr('quotations stay valid'), note: tr('then they expire if not answered'), onClick: () => jump('bs-wording') },
    { icon: 'calendar', value: tr('{n} days', { n: saved.invoiceDueDays || '—' }), label: tr('until an invoice falls due'), note: saved.paymentTerms ? tr('terms: {terms}', { terms: saved.paymentTerms }) : tr('no payment terms written'), onClick: () => jump('bs-wording') },
    { icon: 'card', value: tr('{n} of 2', { n: ways }), label: tr('ways to pay on invoices'), note: [hasBank && tr('bank'), hasMomo && tr('mobile money')].filter(Boolean).join(' · ') || tr('none filled in'), tone: ways === 0 ? 'bad' : ways === 1 ? 'warn' : 'good', onClick: () => jump('bs-pay') },
    { icon: 'percent', value: String(taxRates.length), label: tr('tax rates'), note: taxRates.map((t) => t.name).join(', ') || tr('none yet'), onClick: () => jump('bs-tax') }
  ];
  const insights = [];
  if (!hasBank) insights.push({ tone: 'bad', icon: 'card', text: tr('Invoices show no bank account, so clients can\'t pay by transfer from the invoice alone.'), action: { label: tr('Fill it in'), run: () => jump('bs-pay') } });
  if (!hasMomo) insights.push({ tone: 'warn', icon: 'phone', text: tr('Invoices show no mobile money number.'), action: { label: tr('Fill it in'), run: () => jump('bs-pay') } });
  if (!saved.terms.trim()) insights.push({ tone: 'warn', icon: 'doc', text: tr('There are no terms & conditions for quotations.'), action: { label: tr('Write them'), run: () => jump('bs-wording') } });
  if (!saved.instructions.trim()) insights.push({ tone: 'info', icon: 'info', text: tr('There are no payment instructions, such as which reference to use when paying.'), action: { label: tr('Write them'), run: () => jump('bs-pay') } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Invoices show both ways to pay, and quotations carry terms & conditions.') });

  return (
    <div className="dk tl bs2">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Quotations & Invoicing')}
        title={tr('Billing settings')}
        sub={tr('What every quotation, estimate and invoice is made with: its wording, dates, how clients pay, numbering and tax rates. Press a number to go to that part.')}
        actions={<Link className="btn btn-secondary" to="/settings">{tr('Currencies and company details')}</Link>}
        stats={stats} />

      <Insights items={insights} />

      <form onSubmit={handleSubmit} className="bs2-form">
        <Section id="bs-wording" title={tr('Wording and dates')} sub={tr('Printed on every new quotation and invoice. Changing them doesn\'t touch documents already made.')} card>
          <div className="tl-form">
            <div className="field">
              <label htmlFor="bs-vd">{tr('Default quotation validity (days)')}</label>
              <input id="bs-vd" className="input" type="number" min="1" max="365" step="1" value={form.validityDays} onChange={set('validityDays')} required />
            </div>
            <div className="field">
              <label htmlFor="bs-dd">{tr('Default invoice due period (days)')}</label>
              <input id="bs-dd" className="input" type="number" min="1" max="365" step="1" value={form.invoiceDueDays} onChange={set('invoiceDueDays')} required />
            </div>
            <div className="field tl-span">
              <label htmlFor="bs-pt">{tr('Default payment terms')}</label>
              <input id="bs-pt" className="input" value={form.paymentTerms} onChange={set('paymentTerms')} maxLength={200} />
            </div>
            <div className="field tl-span">
              <label htmlFor="bs-qi">{tr('Quotation introduction')}</label>
              <textarea id="bs-qi" className="input tl-textarea" value={form.quotationIntro} onChange={set('quotationIntro')} maxLength={2000} />
            </div>
            <div className="field">
              <label htmlFor="bs-qf">{tr('Quotation footer')}</label>
              <textarea id="bs-qf" className="input tl-textarea" value={form.quotationFooter} onChange={set('quotationFooter')} maxLength={2000} />
            </div>
            <div className="field">
              <label htmlFor="bs-if">{tr('Invoice footer')}</label>
              <textarea id="bs-if" className="input tl-textarea" value={form.invoiceFooter} onChange={set('invoiceFooter')} maxLength={2000} />
            </div>
            <div className="field tl-span">
              <label htmlFor="bs-terms">{tr('Terms & conditions')}</label>
              <textarea id="bs-terms" className="input tl-textarea bs2-terms" value={form.terms} onChange={set('terms')} maxLength={8000} />
            </div>
          </div>
        </Section>

        <Section id="bs-pay" title={tr('How clients pay')} sub={tr('Shown at the foot of every invoice. The box on the right is how it prints.')} card>
          <div className="bs2-pay">
            <div className="tl-form">
              <div className="field">
                <label htmlFor="bs-bn">{tr('Bank name')}</label>
                <input id="bs-bn" className="input" value={form.bankName} onChange={set('bankName')} maxLength={120} />
              </div>
              <div className="field">
                <label htmlFor="bs-br">{tr('Branch')}</label>
                <input id="bs-br" className="input" value={form.branch} onChange={set('branch')} maxLength={120} />
              </div>
              <div className="field">
                <label htmlFor="bs-an">{tr('Account name')}</label>
                <input id="bs-an" className="input" value={form.accountName} onChange={set('accountName')} maxLength={120} />
              </div>
              <div className="field">
                <label htmlFor="bs-acc">{tr('Account number')}</label>
                <input id="bs-acc" className="input" value={form.accountNumber} onChange={set('accountNumber')} maxLength={60} />
              </div>
              <div className="field">
                <label htmlFor="bs-sw">SWIFT</label>
                <input id="bs-sw" className="input" value={form.swift} onChange={set('swift')} maxLength={20} />
              </div>
              <div className="field">
                <label htmlFor="bs-mp">{tr('Mobile Money provider')}</label>
                <input id="bs-mp" className="input" value={form.momoProvider} onChange={set('momoProvider')} maxLength={60} />
              </div>
              <div className="field">
                <label htmlFor="bs-mn">{tr('Mobile Money number')}</label>
                <input id="bs-mn" className="input" type="tel" value={form.momoNumber} onChange={set('momoNumber')} maxLength={30} />
              </div>
              <div className="field tl-span">
                <label htmlFor="bs-inst">{tr('Payment instructions')}</label>
                <textarea id="bs-inst" className="input tl-textarea" value={form.instructions} onChange={set('instructions')} maxLength={1000} />
              </div>
            </div>
            <aside className="bs2-slip" aria-label={tr('How it prints')}>
              <p className="bs2-slip-title">{tr('How to pay')}</p>
              {form.bankName || form.accountNumber ? (
                <dl>
                  {form.bankName && <><dt>{tr('Bank')}</dt><dd>{form.bankName}{form.branch ? ', ' + form.branch : ''}</dd></>}
                  {form.accountName && <><dt>{tr('Account name')}</dt><dd>{form.accountName}</dd></>}
                  {form.accountNumber && <><dt>{tr('Account number')}</dt><dd className="bs2-mono">{form.accountNumber}</dd></>}
                  {form.swift && <><dt>SWIFT</dt><dd className="bs2-mono">{form.swift}</dd></>}
                </dl>
              ) : <p className="dk-muted tl-small">{tr('No bank account yet.')}</p>}
              {form.momoNumber ? (
                <dl>
                  <dt>{form.momoProvider || tr('Mobile Money')}</dt><dd className="bs2-mono">{form.momoNumber}</dd>
                </dl>
              ) : <p className="dk-muted tl-small">{tr('No mobile money number yet.')}</p>}
              {form.instructions && <p className="bs2-slip-note">{form.instructions}</p>}
            </aside>
          </div>
        </Section>

        <div className={'bs2-savebar' + (dirty ? ' is-dirty' : '')}>
          <span className="dk-muted tl-small">{dirty ? tr('You have changes that aren\'t saved yet.') : tr('Everything is saved.')}</span>
          {dirty && <button type="button" className="btn btn-secondary" onClick={() => setForm(saved)} disabled={saving}>{tr('Undo changes')}</button>}
          <button className="btn btn-primary" type="submit" disabled={saving || !dirty}>{saving ? tr('Saving…') : tr('Save settings')}</button>
        </div>
      </form>

      <Section id="bs-tax" title={tr('Tax rates')} sub={tr('Picked per catalogue item. A rate can be removed once no item uses it; the zero rate always stays.')} card>
        <ul className="rs-list bs2-taxes">
          {taxRates.map((t) => (
            <li key={t.id} className="rs-row">
              <div className="rs-row-open bs2-tax">
                <span className="rs-row-main"><strong>{t.name}</strong></span>
                <span className="rs-row-side"><Status tone={t.rate > 0 ? 'info' : 'muted'}>{t.rate}%</Status></span>
              </div>
              {t.id !== 'tx_zero' && <span className="rs-row-menu"><button type="button" className="btn btn-secondary bs2-remove" disabled={busyTax === t.id} onClick={() => removeTax(t)}>{tr('Remove')}</button></span>}
            </li>
          ))}
        </ul>
        <form className="bs2-taxform" onSubmit={handleAddTaxRate}>
          <div className="field">
            <label htmlFor="bs-taxname">{tr('New tax name')}</label>
            <input id="bs-taxname" className="input" value={taxName} onChange={(e) => setTaxName(e.target.value)} maxLength={40} required />
          </div>
          <div className="field">
            <label htmlFor="bs-taxrate">{tr('Rate %')}</label>
            <input id="bs-taxrate" className="input" type="number" min="0" max="100" step="0.01" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} required />
          </div>
          <button className="btn btn-secondary" type="submit" disabled={addingTax}>{tr('Add')}</button>
        </form>
      </Section>

      <div className="bs2-pair">
        <Section id="bs-numbers" title={tr('Document numbering')} sub={tr('The number the next document of each kind will get. Numbers are never reused.')} card>
          <ul className="rs-lines bs2-numbers">
            {numbering.map((n) => <li key={n.key}><span /><span>{n.doc}</span><strong className="bs2-mono">{n.next}</strong></li>)}
          </ul>
        </Section>
        <Section id="bs-cur" title={tr('Currencies')} sub={tr('Documents can be made in these. Choose them in Company settings.')} card>
          <div className="bs2-curs">{currencies.map((c, i) => <Status key={c} tone={i === 0 ? 'good' : 'muted'}>{c}{i === 0 ? ' · ' + tr('default') : ''}</Status>)}</div>
          <Link className="btn btn-secondary bs2-curlink" to="/settings">{tr('Company settings')}</Link>
        </Section>
      </div>

      <Glossary items={[
        [tr('Validity'), tr('How many days a new quotation stays open. After that it expires if the client hasn\'t answered.')],
        [tr('Due period'), tr('How many days after issue a new invoice falls due. After that it shows as overdue.')],
        [tr('Payment instructions'), tr('A line for clients on how to pay, such as quoting the invoice number as the reference.')],
        [tr('Tax rate'), tr('A percentage added to lines of a catalogue item that uses it.')]
      ]} />

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
