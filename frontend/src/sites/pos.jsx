import RestaurantPosPage from '../pages/RestaurantPosPage';
import CustomerDisplay from '../pages/CustomerDisplay';
import { mountSite } from './mountSite';

// /display on the till's website is the screen that faces the customer.
mountSite(window.location.pathname.replace(/\/+$/, '') === '/display' ? CustomerDisplay : RestaurantPosPage);
