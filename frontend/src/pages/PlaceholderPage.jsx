export default function PlaceholderPage({ title }) {
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Coming soon</div>
      <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
        {title ? title + ' ' : 'This screen '}hasn't been built yet — the API behind it is live and
        tested (see the backend README), it just doesn't have a frontend screen in this pass.
      </p>
    </div>
  );
}
