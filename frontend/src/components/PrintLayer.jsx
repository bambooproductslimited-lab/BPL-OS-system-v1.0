import { useEffect } from 'react';
import { createPortal } from 'react-dom';

// Anything that gets printed lives in here.
//
// The print stylesheets used to hide the app with `body * { visibility:
// hidden }` and then re-show the document. visibility leaves the element's
// LAYOUT in place, so the app still took up the paper it would have taken
// up on screen: printing a one-page invoice from a list of 66 produced five
// sheets, four of them blank, because the list behind the dialog was
// 3,988px tall. Every print path in the app had the same bug, so the same
// invoice printed from a short list looked fine and from a long one did not
// — which is why it looked intermittent.
//
// Rendering into a portal on <body>, beside #root rather than inside it,
// means print CSS can `display: none` the whole application in one rule.
// display, unlike visibility, removes it from the flow, so the only thing
// paginated is the document itself.
export default function PrintLayer({ children }) {
  useEffect(() => {
    document.body.classList.add('has-print-layer');
    return () => document.body.classList.remove('has-print-layer');
  }, []);
  return createPortal(<div className="print-layer">{children}</div>, document.body);
}
