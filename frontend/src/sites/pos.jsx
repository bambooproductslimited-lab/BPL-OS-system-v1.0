import RestaurantPosPage from '../pages/RestaurantPosPage';
import CustomerDisplay from '../pages/CustomerDisplay';
import SelfOrderPage from '../pages/SelfOrderPage';
import { mountSite } from './mountSite';

// /display on the till's website is the screen that faces the customer;
// /self-order, the kiosk customers order on themselves.
const path = window.location.pathname.replace(/\/+$/, '');
mountSite(path === '/display' ? CustomerDisplay : path === '/self-order' ? SelfOrderPage : RestaurantPosPage);
