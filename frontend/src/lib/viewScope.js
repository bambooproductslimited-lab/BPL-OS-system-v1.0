import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr } from './i18n.jsx';

// Who the signed-in person can see (backend viewScope.service.js), for the
// line on the Employee directory and Attendance that explains why the list
// holds the people it does. Nothing for roles that see everyone.
export function useMyViewScope(seesAll) {
  const [scope, setScope] = useState(null);
  useEffect(() => {
    if (seesAll) return undefined;
    let alive = true;
    api.get('/employees/me/view-scope').then((s) => alive && setScope(s)).catch(() => {});
    return () => { alive = false; };
  }, [seesAll]);
  return scope;
}

export function viewScopeInsight(scope) {
  if (!scope || scope.seesAll) return null;
  const parts = [];
  if (scope.teamCount) parts.push(tr('your team ({n})', { n: scope.teamCount }));
  scope.departments.forEach((d) => parts.push(tr('everyone in {department}', { department: d.name })));
  if (scope.people.length) parts.push(scope.people.length === 1 ? scope.people[0].name : tr('{n} other people', { n: scope.people.length }));
  if (!parts.length) {
    if (!scope.managerial) return null;
    return { tone: 'info', icon: 'eye', text: tr('You see only yourself here: nobody reports to you yet and HR has not given you any departments or people.') };
  }
  return { tone: 'info', icon: 'eye', text: tr('You see {list}. HR decides who each manager can see.', { list: parts.join(', ') }) };
}
