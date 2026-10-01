import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr } from './i18n.jsx';

// Who the signed-in person can see (backend viewScope.service.js), for the
// line on the Employee directory and Attendance that explains why the list
// holds the people it does, and to keep the company switcher to the
// companies they can see. `skip` when the page shows only themselves.
export function useMyViewScope(skip) {
  const [scope, setScope] = useState(null);
  useEffect(() => {
    if (skip) return undefined;
    let alive = true;
    api.get('/employees/me/view-scope').then((s) => alive && setScope(s)).catch(() => {});
    return () => { alive = false; };
  }, [skip]);
  return scope;
}

// The companies someone may pick in a switcher: all, unless theirs are ticked.
export function companiesInReach(companies, scope) {
  if (!scope || !scope.seesAll || !scope.companiesLimited) return companies;
  const ok = new Set(scope.companies.map((c) => c.id));
  return companies.filter((c) => ok.has(c.id));
}

export function viewScopeInsight(scope) {
  if (!scope) return null;
  if (scope.seesAll) {
    if (!scope.companiesLimited) return null;
    return { tone: 'info', icon: 'eye', text: tr('You see everyone at {companies}. HR or an administrator decides which companies each person can see.', { companies: scope.companies.map((c) => c.name).join(', ') }) };
  }
  const parts = [];
  scope.companies.forEach((c) => parts.push(tr('everyone at {company}', { company: c.name })));
  if (scope.teamCount) parts.push(tr('your team ({n})', { n: scope.teamCount }));
  scope.departments.forEach((d) => parts.push(tr('everyone in {department}', { department: d.name })));
  if (scope.people.length) parts.push(scope.people.length === 1 ? scope.people[0].name : tr('{n} other people', { n: scope.people.length }));
  if (!parts.length) {
    if (!scope.managerial) return null;
    return { tone: 'info', icon: 'eye', text: tr('You see only yourself here: nobody reports to you yet and HR has not given you any departments or people.') };
  }
  return { tone: 'info', icon: 'eye', text: tr('You see {list}. HR decides who each manager can see.', { list: parts.join(', ') }) };
}
