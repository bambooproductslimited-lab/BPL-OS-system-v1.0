import RestaurantPosPage from '../pages/RestaurantPosPage';
import CustomerDisplay from '../pages/CustomerDisplay';
import SelfOrderPage from '../pages/SelfOrderPage';
import ReadyBoardPage from '../pages/ReadyBoardPage';
import MenuBoardPage from '../pages/MenuBoardPage';
import { mountSite } from './mountSite';

// /display on the till's website is the screen that faces the customer;
// /self-order, the kiosk customers order on themselves; /ready-board, the TV
// that shows the counter's orders preparing and ready; /menu-board, a TV
// showing the menu (migration 0195).
const path = window.location.pathname.replace(/\/+$/, '');
mountSite(path === '/display' ? CustomerDisplay : path === '/self-order' ? SelfOrderPage : path === '/ready-board' ? ReadyBoardPage : path === '/menu-board' ? MenuBoardPage : RestaurantPosPage);
