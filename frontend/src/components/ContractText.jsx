// A contract's words as written (backend contracts.service.js): a line
// starting "# " is its title, "## " a heading, "- " a point in a list; the
// rest are paragraphs, one per blank line. Plain text throughout: nothing
// in the words is taken as HTML.
export default function ContractText({ body, className }) {
  const blocks = String(body || '').split(/\n{2,}/);
  return (
    <div className={'ctx' + (className ? ' ' + className : '')}>
      {blocks.map((b, i) => {
        const lines = b.split('\n').filter((l) => l.trim() !== '');
        if (!lines.length) return null;
        const out = [];
        let list = [], para = [];
        const flush = () => {
          if (para.length) { out.push(<p key={'p' + out.length}>{para.join(' ')}</p>); para = []; }
          if (list.length) { out.push(<ul key={'u' + out.length}>{list.map((x, j) => <li key={j}>{x}</li>)}</ul>); list = []; }
        };
        lines.forEach((l) => {
          if (/^#\s+/.test(l)) { flush(); out.push(<h1 key={'h' + out.length}>{l.replace(/^#\s+/, '')}</h1>); } else if (/^##\s+/.test(l)) { flush(); out.push(<h2 key={'h' + out.length}>{l.replace(/^##\s+/, '')}</h2>); } else if (/^[-•]\s+/.test(l)) { if (para.length) flush(); list.push(l.replace(/^[-•]\s+/, '')); } else { if (list.length) flush(); para.push(l); }
        });
        flush();
        return <div key={i} className="ctx-block">{out}</div>;
      })}
    </div>
  );
}
