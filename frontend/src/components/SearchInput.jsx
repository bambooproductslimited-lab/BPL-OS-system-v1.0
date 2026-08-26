import './SearchInput.css';

// Shared search box for list/table screens across Bamboo OS. Filtering
// itself stays local to each page (a simple .filter() over whatever fields
// make sense there) — every list screen already fetches its full list into
// state and renders a table client-side, so there's no separate backend
// search endpoint to call; this is just the consistent input UI plus the
// place to document the pattern once instead of per page.
export default function SearchInput({ value, onChange, placeholder }) {
  return (
    <div className="search-input-wrap">
      <svg className="search-input-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M18 18L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        type="text"
        className="input search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || 'Search…'}
      />
      {value && (
        <button type="button" className="search-input-clear" aria-label="Clear search" onClick={() => onChange('')}>×</button>
      )}
    </div>
  );
}

// normalize() — case/whitespace-insensitive matching helper shared by every
// page's own filter function.
export function normalize(v) {
  return (v == null ? '' : String(v)).toLowerCase().trim();
}

// matchesQuery(query, ...fields) — true if the search query is a substring
// of any given field (already normalized). An empty query always matches
// (shows everything), same as no filter applied.
export function matchesQuery(query, ...fields) {
  const q = normalize(query);
  if (!q) return true;
  return fields.some((f) => normalize(f).includes(q));
}
