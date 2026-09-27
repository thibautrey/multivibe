import type { GitHubReleaseNotes } from "../release-announcement";

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

export function ReleaseAnnouncementCard({
  version,
  release,
  onOpen,
  onDismiss,
}: {
  version: string;
  release: GitHubReleaseNotes | null;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={`release-announcement-card${release?.bannerUrl ? " has-banner" : ""}`}>
      <button type="button" className="release-announcement-open" onClick={onOpen} aria-label={`Read the release notes for MultiVibe version ${version}`}>
        {release?.bannerUrl && <img src={release.bannerUrl} alt={release.bannerAlt} />}
        <span className="release-announcement-copy">
          <small>MultiVibe updated</small>
          <strong>Version {version}</strong>
          <span>See what’s new <span aria-hidden="true">→</span></span>
        </span>
      </button>
      <button type="button" className="release-announcement-dismiss" onClick={onDismiss} aria-label={`Hide the update notice for version ${version}`}>
        <CloseIcon />
      </button>
    </div>
  );
}

export function ReleaseNotesBody({ body }: { body: string }) {
  if (!body.trim()) return <p className="release-notes-empty">This release does not include additional notes.</p>;
  return <div className="release-notes-body">
    {body.split(/\r?\n/u).map((line, index) => {
      const heading = /^(#{1,4})\s+(.+)$/u.exec(line);
      if (heading) return <h3 key={index}>{heading[2]}</h3>;
      const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
      if (bullet) return <p className="release-note-list-item" key={index}><span aria-hidden="true">•</span>{bullet[1]}</p>;
      if (!line.trim()) return <span className="release-note-break" key={index} aria-hidden="true" />;
      return <p key={index}>{line}</p>;
    })}
  </div>;
}

export function ReleaseNotesModal({
  version,
  release,
  loading,
  error,
  fallbackUrl,
  onClose,
}: {
  version: string;
  release: GitHubReleaseNotes | null;
  loading: boolean;
  error: string;
  fallbackUrl: string;
  onClose: () => void;
}) {
  const published = release?.publishedAt ? new Date(release.publishedAt) : null;
  const validPublished = published && !Number.isNaN(published.getTime()) ? published : null;
  return <section className="modal panel release-notes-modal" role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
    <button className="modal-close-button release-notes-close" type="button" onClick={onClose} aria-label="Close release notes"><CloseIcon /></button>
    {release?.bannerUrl && <img className="release-notes-banner" src={release.bannerUrl} alt={release.bannerAlt} />}
    <header className="release-notes-header">
      <span className="eyebrow">Update installed · Version {version}</span>
      <h2 id="release-notes-title">{release?.title ?? `MultiVibe v${version}`}</h2>
      {validPublished && <small>Released {validPublished.toLocaleDateString()}</small>}
    </header>
    {loading && <p className="muted release-notes-loading">Loading release notes from GitHub…</p>}
    {!loading && error && <div className="error release-notes-error" role="alert">{error}</div>}
    {!loading && !error && release && <ReleaseNotesBody body={release.body} />}
    <footer className="release-notes-actions">
      <a className="btn secondary" href={release?.htmlUrl ?? fallbackUrl} target="_blank" rel="noreferrer">View release on GitHub</a>
      <button className="btn" type="button" onClick={onClose}>Done</button>
    </footer>
  </section>;
}
