import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import NavIcon from '../../layout/navIcons';
import { tr, msg } from '../../lib/i18n.jsx';
import CrmCustomersPage from './CrmCustomersPage';
import CrmProspectsPage from './CrmProspectsPage';
import CrmInboxPage from './CrmInboxPage';
import CrmFollowUpsPage from './CrmFollowUpsPage';
import './CrmHub.css';

// Two pages that belong together, under one sidebar entry each: customers
// and the prospects who may become customers; the inbox and the follow-ups
// it turns into. The tab is in the address (?tab=…), so a link can open
// either side, and the old addresses (/crmprospects, /crmfollowups) land on
// the right tab (App.jsx).

function Tabs({ tabs, label }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const cur = tabs.find((t) => t.key === asked) || tabs[0];
  const Page = cur.Page;
  return (
    <>
      <div className="hub-tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={t === cur} className={'hub-tab' + (t === cur ? ' is-on' : '')}
            onClick={() => { if (t !== cur) setParams(t === tabs[0] ? {} : { tab: t.key }); }}>
            <NavIcon name={t.icon} />
            <span>{tr(t.label)}</span>
            {t.count > 0 && <span className="hub-tab-n">{t.count}</span>}
          </button>
        ))}
      </div>
      <Page key={cur.key} />
    </>
  );
}

export function CrmCustomersHub() {
  return <Tabs label={tr('Customers & prospects')} tabs={[
    { key: 'customers', label: msg('Customers'), icon: 'user', Page: CrmCustomersPage },
    { key: 'prospects', label: msg('Prospects'), icon: 'megaphone', Page: CrmProspectsPage }
  ]} />;
}

export function CrmInboxHub() {
  // How many follow-ups are waiting, on the tab, so they are not missed
  // while reading the inbox.
  const [due, setDue] = useState(0);
  useEffect(() => {
    let alive = true;
    api.get('/crm/follow-ups/mine').then((x) => { if (alive && x) setDue(x.total || 0); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return <Tabs label={tr('Inbox & follow-ups')} tabs={[
    { key: 'inbox', label: msg('Inbox'), icon: 'chat', Page: CrmInboxPage },
    { key: 'followups', label: msg('My follow-ups'), icon: 'bell', Page: CrmFollowUpsPage, count: due }
  ]} />;
}
