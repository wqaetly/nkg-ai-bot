import type { ChatWebReference } from "./chatContent";

export function SearchReferencesPanel({ references }: { references: ChatWebReference[] }) {
  if (!references.length) return null;
  return (
    <details className="search-references-panel">
      <summary>
        <span className="search-references-symbol" aria-hidden="true">↗</span>
        <span>联网搜索参考</span>
        <small>{references.length} 个网页</small>
        <span className="search-references-chevron" aria-hidden="true">⌄</span>
      </summary>
      <ol className="search-references-list">
        {references.map((reference) => (
          <li key={reference.url}>
            <a href={reference.url} rel="noreferrer" target="_blank">
              <span className="search-reference-title">{reference.title}</span>
              <span className="search-reference-host">{referenceHost(reference.url)}</span>
              {reference.snippet ? <span className="search-reference-snippet">{reference.snippet}</span> : null}
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}

function referenceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
