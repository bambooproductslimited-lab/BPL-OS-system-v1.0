import { useCallback } from 'react';
import { posFetch } from '../../lib/posApi';
import RestaurantReport from '../RestaurantReport';
import '../RestaurantsPage.css';

// The monthly report in the till's back office (TillSettings.jsx, Reports):
// the OS's report (RestaurantReport.jsx) over the sales brought in from
// Square and the till's own — kitchen groups, shifts and hours, the best
// sellers and the kitchen bonus (backend restaurantTillAccess monthlyReport).
// Read only: its groups, shifts and bonus rule are set in the OS.
export default function MonthlyReport({ token, pin, companyName }) {
  const load = useCallback((month) => posFetch('POST', '/pos/settings/monthly-report', token, { managerPin: pin || undefined, month: month || undefined }), [token, pin]);
  return <div className="ts-sec ts-monthly"><RestaurantReport companyId="till" companyName={companyName} canManage={false} onToast={() => {}} load={load} /></div>;
}
