import { Component } from 'react';
import { tr } from '../lib/i18n.jsx';
import './ErrorBoundary.css';

// Without one of these, any error thrown while rendering unmounts the whole
// React tree and leaves a blank white page. That is what "it just shows a
// white screen" means: not a missing page, but a crash with nothing left to
// display it. The app had no boundary anywhere, so every crash looked the
// same and said nothing about itself.
//
// This keeps the failure where it happened, shows what went wrong, and
// leaves the rest of the app usable. `scope` names the part that failed so
// the message can say "this page" rather than "the application".
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, showDetail: false };
  }

  static getDerivedStateFromError(error) {
    return { error: error };
  }

  componentDidCatch(error, info) {
    this.setState({ info: info });
    // Still worth logging: the console is where a developer looks first, and
    // this keeps the stack available even after the UI has recovered.
    console.error('Render error in ' + (this.props.scope || 'app') + ':', error, info);
  }

  reset = () => this.setState({ error: null, info: null, showDetail: false });

  render() {
    if (!this.state.error) return this.props.children;
    const { error, info, showDetail } = this.state;
    const where = this.props.scope || 'the application';
    return (
      <div className="errbound">
        <div className="errbound-card">
          <h2 className="errbound-title">{tr('Something in')} {where} {tr('stopped working')}</h2>
          <p className="errbound-body">
            {tr('Nothing was saved or lost — this screen failed to draw. You can try again, or move to another page and come back.')}
          </p>
          <p className="errbound-message">{String(error && error.message ? error.message : error)}</p>
          <div className="errbound-actions">
            <button type="button" className="btn btn-primary" onClick={this.reset}>{tr('Try again')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>{tr('Reload the page')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => this.setState({ showDetail: !showDetail })}>
              {showDetail ? tr('Hide details') : tr('Show details')}
            </button>
          </div>
          {showDetail && (
            <pre className="errbound-detail">
              {String(error && error.stack ? error.stack : error)}
              {info && info.componentStack ? tr('\n\nComponent stack:') + info.componentStack : ''}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
