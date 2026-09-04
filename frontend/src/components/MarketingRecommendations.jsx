import { useState } from 'react';
import { api } from '../api/client';
import './MarketingRecommendations.css';

// Shared by MarketingDashboardPage and SocialTrackerPage — both call the
// same GET /api/marketing/recommendations (marketing.service.js), which
// ranks this account's own real post/channel numbers (top/bottom
// performing posts, channels with no recent activity) and hands that
// snapshot to the AI Assistant's same Anthropic call to turn into a short
// written brief. Generated on demand (a button, not on page load) since
// it's an LLM call, not a free query — and its result (recommendation +
// basedOn) is handed back to the parent page via onGenerated so it can be
// folded into that page's CSV/PDF export.
export default function MarketingRecommendations({ onGenerated }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/marketing/recommendations');
      setResult(r);
      if (onGenerated) onGenerated(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mkt-reco">
      <div className="mkt-reco-header">
        <h2 className="mkt-reco-title">Content recommendations</h2>
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={generate}>
          {loading ? 'Thinking…' : result ? 'Regenerate' : 'Generate recommendations'}
        </button>
      </div>
      <p className="field-hint">
        Based on this account's own post and channel numbers from the last 90 days — what to post more of, and
        which channel or campaign needs a promotional push.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {result && <p className="mkt-reco-text">{result.recommendation}</p>}
      {!result && !loading && !error && <p className="table-empty">Not generated yet for this session.</p>}
    </div>
  );
}
