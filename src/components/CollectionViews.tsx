import type { CollectionCard, CollectionDetail } from "../server/queries.ts";
import type { CollectionSort } from "../server/library-query.ts";
import { Thumbnail } from "./MediaTable.tsx";
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

export function CollectionsOverviewView({ owned, sharedWithMe, search = "", sort = "newest", filtered = false }: { owned: CollectionCard[]; sharedWithMe: CollectionCard[]; search?: string; sort?: CollectionSort; filtered?: boolean }) {
  return (
    <>
      <h1>Collections</h1>
      <form method="get" action="/collections" className="filter-bar" role="search">
        <p><label>Search collections<br /><input type="search" name="q" defaultValue={search} maxLength={100} /></label></p>
        <p><label>Sort<br /><select name="sort" defaultValue={sort} aria-label="Sort collections"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option></select></label></p>
        <p><button type="submit">Apply</button></p>
      </form>
      <section aria-labelledby="owned-heading"><h2 id="owned-heading">Your collections</h2><CollectionList collections={owned} emptyText={filtered ? "No collections match that search." : "You have no collections yet."} /></section>
      <section aria-labelledby="new-collection-heading" className="card">
        <h2 id="new-collection-heading">New collection</h2>
        <form method="post" action="/api/forms/collection-create">
          <p><label>Name<br /><input type="text" name="name" required maxLength={100} /></label></p>
          <p><label>Description<br /><input type="text" name="description" maxLength={500} /></label></p>
          <p><label>Who can open it<br /><select name="visibility"><option value="private">Private</option><option value="link">Shared by link</option><option value="public_view">Public (view only)</option></select></label></p>
          <button type="submit">Create collection</button>
        </form>
      </section>
      <section aria-labelledby="shared-heading"><h2 id="shared-heading">Shared with you</h2><CollectionList collections={sharedWithMe} emptyText={filtered ? "No shared collections match that search." : "Nobody has shared a collection with you."} /></section>
    </>
  );
}

/** Add videos to one of YOUR cycles. Shared videos are used in place (no copy). The server re-checks every permission. */
function MixForm({ detail }: { detail: CollectionDetail }) {
  const { permissions, cycleChoices, videos, collection } = detail;
  if (!permissions.canUseInCycle) return null;
  if (cycleChoices.length === 0) return <p className="muted">Create a publishing cycle to add these videos to it.</p>;
  return (
    <form method="post" action="/api/forms/cycle-mix" aria-labelledby="mix-heading" className="card">
      <h2 id="mix-heading">Add videos to a publishing cycle</h2>
      <input type="hidden" name="collectionId" value={collection.id} />
      <p><label>Cycle<br /><select name="cycleId" required>{cycleChoices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></p>
      <fieldset><legend>Videos</legend>
        {videos.map((v) => <p key={v.id}><label><input type="checkbox" name="video" value={`${collection.id}|${v.id}`} /> {v.title}</label></p>)}
      </fieldset>
      {!permissions.isOwner && <p className="muted">These videos stay with their owner: ClipForge uses them in place and does not copy them to your storage.</p>}
      <button type="submit">Add ticked videos to the cycle</button>
    </form>
  );
}

export function CollectionDetailView({ detail }: { detail: CollectionDetail }) {
  const { collection, videos, permissions } = detail;
  const members = new Set(detail.memberIds ?? []);
  const shown = new Set(detail.libraryChoices.map((item) => item.id));
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
      <MixForm detail={detail} />
      {permissions.isOwner && (
        <>
          <section aria-labelledby="edit-collection-heading" className="card">
            <h2 id="edit-collection-heading">Collection details</h2>
            <form method="post" action="/api/forms/collection-update">
              <input type="hidden" name="collectionId" value={collection.id} />
              <p><label>Name<br /><input type="text" name="name" required maxLength={100} defaultValue={collection.name} /></label></p>
              <p><label>Description<br /><input type="text" name="description" maxLength={500} defaultValue={collection.description ?? ""} /></label></p>
              <p><label>Who can open it<br /><select name="visibility" defaultValue={collection.visibility}><option value="private">Private</option><option value="link">Shared by link</option><option value="public_view">Public (view only)</option></select></label></p>
              <button type="submit">Save collection</button>
            </form>
          </section>
          <section aria-labelledby="membership-heading" className="card">
            <h2 id="membership-heading">Files in this collection</h2>
            <p className="muted">The same file can belong to more than one collection. Taking it out of this list does not delete the original, and it stays in every other collection.</p>
            {detail.libraryChoices.length === 0 ? <p>Upload a file in the <a href="/media">media library</a> before adding it here.</p> : (
              <form method="post" action="/api/forms/collection-media">
                <input type="hidden" name="collectionId" value={collection.id} />
                {(detail.memberIds ?? []).filter((id) => !shown.has(id)).map((id) => <input key={id} type="hidden" name="mediaIds" value={id} />)}
                {detail.libraryChoices.map((item) => <p key={item.id}><label><input type="checkbox" name="mediaIds" value={item.id} defaultChecked={members.has(item.id)} /> {item.title}</label></p>)}
                {detail.libraryTruncated && <p className="muted">Only the first 200 files by name are listed here.</p>}
                <button type="submit">Save this list</button>
              </form>
            )}
          </section>
          <section aria-labelledby="danger-heading" className="card">
            <h2 id="danger-heading">Archive or delete</h2>
            <p>These actions change the collection only. They do not delete videos from your library.</p>
            <form method="post" action="/api/forms/collection-archive">
              <input type="hidden" name="collectionId" value={collection.id} />
              <input type="hidden" name="archived" value={collection.archived ? "no" : "yes"} />
              <p><label><input type="checkbox" name="confirm" value="yes" required /> {collection.archived ? "Restore this collection. The videos stay where they are." : "Archive this collection. The videos stay in the library."}</label></p>
              <button type="submit">{collection.archived ? "Restore collection" : "Archive collection"}</button>
            </form>
            <form method="post" action="/api/forms/collection-delete">
              <input type="hidden" name="collectionId" value={collection.id} />
              <p><label><input type="checkbox" name="confirm" value="yes" required /> Delete this collection. The videos stay in the library and in every other collection.</label></p>
              <button type="submit">Delete collection</button>
            </form>
          </section>
        </>
      )}
      <section aria-labelledby="videos-heading">
        <h2 id="videos-heading">Videos</h2>
        <form method="get" action={`/collections/${collection.id}`} className="filter-bar" role="search">
          <p><label>Search videos<br /><input type="search" name="q" defaultValue={detail.videoSearch ?? ""} maxLength={100} /></label></p>
          <p><label>Sort<br /><select name="sort" defaultValue={detail.videoSort ?? "newest"} aria-label="Sort videos in this collection"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option><option value="size">Size</option></select></label></p>
          <p><button type="submit">Apply</button></p>
        </form>
        {videos.length === 0 ? <p>{detail.videoFiltered ? "No videos in this collection match that search." : "This collection has no videos."}</p> : (
          <div className="table-scroll"><table className="data-table"><caption>Videos in this collection</caption>
            <thead><tr><th scope="col">Preview</th><th scope="col">Title</th><th scope="col">Length</th><th scope="col">Size</th></tr></thead>
            <tbody>{videos.map((v) => <tr key={v.id}><td><Thumbnail media={v} /></td><td>{v.title}</td><td>{formatDuration(v.durationMs)}</td><td>{formatStorage(v.sizeBytes)}</td></tr>)}</tbody></table></div>
        )}
      </section>
    </>
  );
}
