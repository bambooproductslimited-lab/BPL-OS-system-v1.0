import { lazy } from 'react';

// The sales team's app inside the OS (oseitutu.com/sales, main.jsx), loaded
// only when that address is opened.
export const LazySalesApp = lazy(() => import('./SalesApp.jsx'));
