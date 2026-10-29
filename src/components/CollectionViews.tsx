import type { CollectionCard, CollectionDetail } from "../server/queries.ts";
import { CAPABILITY_LABELS, VISIBILITY_LABELS, formatCount, formatDuration, formatStorage } from "./format.ts";

function CollectionList({ collections, emptyText }: { collections: CollectionCard[]; emptyText: string }) {
  if (collections.length === 0) return <p>{emptyText}</p>;
  return (
    <ul className="card-list">
      {collections.map((c) => (
        <li key={c.id} className="card" data-collection-id={c.id}>
          <h3><a href={`/collections/${c.id}`}>{c.name}</a></h3>
          {c.description && <p>{c.description}</p>}
          <p className="muted">{formatCount(c.videoCount)} video{c.videoCount === 1 ? "" : "s"} - {VISIBILITY_LABELS[c.visibility]}{c.archived ? " - Archived" : ""}</p>
          {c.sharedByAnotherUser && <p>You can: {c.capabilities.length ? c.capabilities.map((cap) => CAPABILITY_LABELS[cap]).join(", ") : "nothing yet"}.</p>}
        </li>
      ))}
    </ul>
  );
}

export function CollectionsOverviewView({ owned, sharedWithMe }: { owned: CollectionCard[]; sharedWithMe: CollectionCard[] }) {
  return (
    <>
      <h1>Collections</h1>
      <section aria-labelledby="owned-heading"><h2 id="owned-heading">Your collections</h2><CollectionList collections={owned} emptyText="You have no collections yet. Creating collections is not available in the screens yet." /></section>
      <section aria-labelledby="shared-heading"><h2 id="shared-heading">Shared with you</h2><CollectionList collections={sharedWithMe} emptyText="Nobody has shared a collection with you." /></section>
    </>
  );
}

export function CollectionDetailView({ detail }: { detail: CollectionDetail }) {
  const { collection, videos, permissions } = detail;
  return (
    <>
      <p><a href="/collections">All collections</a></p>
      <h1>{collection.name}</h1>
      {collection.description && <p>{collection.description}</p>}
      <p className="muted">{VISIBILITY_LABELS[collection.visibility]}{collection.sharedByAnotherUser ? " - shared with you by another user" : " - yours"}</p>
      <section aria-labelledby="perm-heading">
        <h2 id="perm-heading">What you can do here</h2>
        <ul>
          <li>View the videos: yes</li>
          <li>Use videos in a publishing cycle without copying them: {permissions.canUseInCycle ? "yes" : "no"}</li>
          <li>Import an independent copy: {permissions.canImport ? "yes" : "no"}</li>
          <li>Download originals: {permissions.canDownload ? "yes" : "no"}</li>
        </ul>
        {!permissions.isOwner && <p className="muted">Permission to use content does not give you rights to redistribute it outside ClipForge.</p>}
      </section>
      <section aria-labelledby="videos-heading">
        <h2 id="videos-heading">Videos</h2>
        {videos.length === 0 ? <p>This collection has no videos.</p> : (
          <div className="table-scroll"><table className="data-table"><caption>Videos in this collection</caption>
            <thead><tr><th scope="col">Title</th><th scope="col">Length</th><th scope="col">Size</th></tr></thead>
            <tbody>{videos.map((v) => <tr key={v.id}><td>{v.title}</td><td>{formatDuration(v.durationMs)}</td><td>{formatStorage(v.sizeBytes)}</td></tr>)}</tbody></table></div>
        )}
      </section>
    </>
  );
}
