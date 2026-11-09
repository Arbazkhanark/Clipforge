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

export function CollectionsOverviewView({ owned, sharedWithMe, accessRequests = [], search = "", sort = "newest", filtered = false }: { owned: CollectionCard[]; sharedWithMe: CollectionCard[]; accessRequests?: { id: string; collectionId: string; requestedCapabilities: import("../lib/domain/types.ts").Capability[]; status: "pending" | "approved" | "rejected"; createdAt: Date; decidedAt: Date | null }[]; search?: string; sort?: CollectionSort; filtered?: boolean }) {
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
      <section aria-labelledby="access-request-heading" className="card">
        <h2 id="access-request-heading">Request collection access</h2>
        <p>Enter a collection ID you received from its owner. ClipForge will not reveal whether an unknown private collection exists.</p>
        <form method="post" action="/api/forms/access-request">
          <p><label>Collection ID<br /><input name="collectionId" required maxLength={64} pattern="[A-Za-z0-9_-]{1,64}" /></label></p>
          <fieldset><legend>Access requested</legend>
            {(["view", "use_in_cycle", "import_copy", "download"] as const).map((capability) => <label key={capability} className="checkbox-row"><input type="checkbox" name="requestedCapabilities" value={capability} /> {CAPABILITY_LABELS[capability]}</label>)}
          </fieldset>
          <button type="submit">Send access request</button>
        </form>
      </section>
      <section aria-labelledby="my-access-requests-heading">
        <h2 id="my-access-requests-heading">Your access requests</h2>
        {accessRequests.length === 0 ? <p>You have no access requests.</p> : <ul className="card-list">{accessRequests.map((request) => <li className="card" key={request.id}><p>Collection ID: <code>{request.collectionId}</code></p><p>Status: {request.status}</p><p>Requested: {request.requestedCapabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}</p><p>Sent: {request.createdAt.toISOString()}{request.decidedAt ? ` — decided ${request.decidedAt.toISOString()}` : ""}</p></li>)}</ul>}
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
          {detail.sharingManagement && (
            <section aria-labelledby="sharing-management-heading" className="card">
              <h2 id="sharing-management-heading">People with collection access</h2>
              <p>{detail.sharingManagement.activeRecipients} of {detail.sharingManagement.recipientLimit} recipient slots are in use on this collection. Limits follow your current plan.</p>
              {detail.sharingManagement.grants.length === 0 ? <p>No direct access grants yet.</p> : (
                <ul className="card-list">
                  {detail.sharingManagement.grants.map((grant) => (
                    <li key={grant.granteeId} className="card">
                      <p><strong>User ID:</strong> <code>{grant.granteeId}</code> — {grant.status}</p>
                      <p>Permissions: {grant.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}</p>
                      <p>Expires: {grant.expiresAt ? grant.expiresAt.toISOString() : "Never"}</p>
                      {grant.status === "active" && <form method="post" action="/api/forms/sharing-revoke">
                        <input type="hidden" name="collectionId" value={collection.id} />
                        <input type="hidden" name="granteeId" value={grant.granteeId} />
                        <button type="submit">Revoke access</button>
                      </form>}
                    </li>
                  ))}
                </ul>
              )}
              {detail.sharingManagement.recipientLimit === 0 ? <p>Your current plan does not include collection sharing.</p> : (
                <form method="post" action="/api/forms/sharing-grant">
                  <input type="hidden" name="collectionId" value={collection.id} />
                  {detail.sharingManagement.activeRecipients >= detail.sharingManagement.recipientLimit && <p className="muted">The recipient limit is full. The server may still allow updating an existing recipient, but it will reject adding another person.</p>}
                  <p><label>Recipient user ID<br /><input name="granteeId" required maxLength={64} pattern="[A-Za-z0-9_-]{1,64}" /></label></p>
                  <fieldset><legend>Permissions to grant</legend>
                    {(["view", "use_in_cycle", "import_copy", "download"] as const).map((capability) => <label key={capability} className="checkbox-row"><input type="checkbox" name="capabilities" value={capability} /> {CAPABILITY_LABELS[capability]}</label>)}
                    {detail.sharingManagement.delegatedManagement && <label className="checkbox-row"><input type="checkbox" name="capabilities" value="manage" /> {CAPABILITY_LABELS.manage} (delegated manager; grants expire within 90 days)</label>}
                  </fieldset>
                  {detail.sharingManagement.expiringGrants && <p><label>Expiry (ISO date-time with timezone, e.g. 2026-12-01T10:00:00Z)<br /><input name="expiresAt" type="text" maxLength={40} placeholder="Optional" /></label></p>}
                  <p className="muted">The server checks the recipient, permissions, expiration, delegated-manager rules and current plan limit before saving.</p>
                  <button type="submit">Grant collection access</button>
                </form>
              )}
            </section>
          )}
          {detail.shareLinks && detail.sharingManagement && (
            <section aria-labelledby="share-links-heading" className="card">
              <h2 id="share-links-heading">Secure share links</h2>
              <p>Share links grant only the permissions shown here. They never grant management access. The full link is shown once when created; stored links below do not reveal it.</p>
              {detail.shareLinks.length === 0 ? <p>No share links have been created.</p> : <ul className="card-list">{detail.shareLinks.map((link) => <li className="card" key={link.id}>
                <p><strong>Link ID:</strong> <code>{link.id}</code> — {link.revokedAt ? "revoked" : link.expiresAt && link.expiresAt <= new Date() ? "expired" : "active"}</p>
                <p>Permissions: {link.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}</p>
                <p>Expires: {link.expiresAt ? link.expiresAt.toISOString() : "Never"}</p>
                <p>Created: {link.createdAt.toISOString()}</p>
                {!link.revokedAt && <>
                  <form method="post" action="/api/forms/share-link-update">
                    <input type="hidden" name="collectionId" value={collection.id} /><input type="hidden" name="shareLinkId" value={link.id} />
                    <fieldset><legend>Update link permissions</legend>
                      {(["view", "import_copy", "download"] as const).map((capability) => <label key={capability} className="checkbox-row"><input type="checkbox" name="capabilities" value={capability} defaultChecked={link.capabilities.includes(capability)} /> {CAPABILITY_LABELS[capability]}</label>)}
                    </fieldset>
                    <p className="muted">Publishing-cycle use must be granted directly by the collection owner.</p>
                    {detail.sharingManagement?.expiringGrants && <p><label>Expiry (ISO date-time; leave blank for no expiry)<br /><input name="expiresAt" type="text" maxLength={40} defaultValue={link.expiresAt?.toISOString() ?? ""} /></label></p>}
                    <button type="submit">Save link permissions</button>
                  </form>
                  <form method="post" action="/api/forms/share-link-revoke">
                    <input type="hidden" name="collectionId" value={collection.id} /><input type="hidden" name="shareLinkId" value={link.id} />
                    <button type="submit">Revoke link</button>
                  </form>
                </>}
              </li>)}</ul>}
              {detail.sharingManagement.recipientLimit === 0 ? <p>Your current plan does not include collection sharing.</p> : collection.visibility !== "link" || collection.archived ? <p>Set this collection to link visibility and make it active before creating a share link.</p> : <form method="post" action="/api/forms/share-link-create">
                <input type="hidden" name="collectionId" value={collection.id} />
                <fieldset><legend>Permissions for the new link</legend>
                  {(["view", "import_copy", "download"] as const).map((capability) => <label key={capability} className="checkbox-row"><input type="checkbox" name="capabilities" value={capability} defaultChecked={capability === "view"} required={capability === "view"} /> {CAPABILITY_LABELS[capability]}</label>)}
                </fieldset>
                <p className="muted">Publishing-cycle use must be granted directly by the collection owner.</p>
                {detail.sharingManagement.expiringGrants && <p><label>Expiry (ISO date-time; leave blank for no expiry)<br /><input name="expiresAt" type="text" maxLength={40} placeholder="Optional" /></label></p>}
                <p className="muted">The server checks your current plan and collection state. Link permissions are rechecked on every visit and action.</p>
                <button type="submit">Create one-time share link</button>
              </form>}
            </section>
          )}
          {detail.pendingAccessRequests && (
            <section aria-labelledby="pending-requests-heading" className="card">
              <h2 id="pending-requests-heading">Pending access requests</h2>
              {detail.pendingAccessRequests.length === 0 ? <p>No pending requests.</p> : <ul className="card-list">{detail.pendingAccessRequests.map((request) => <li className="card" key={request.id}>
                <p>Requester user ID: <code>{request.requesterId}</code></p>
                <p>Requested: {request.requestedCapabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}</p>
                <p>Sent: {request.createdAt.toISOString()}</p>
                <form method="post" action="/api/forms/access-request-decision">
                  <input type="hidden" name="collectionId" value={collection.id} /><input type="hidden" name="requestId" value={request.id} />
                  <button name="decision" value="approved" type="submit">Approve requested access</button>{" "}<button name="decision" value="rejected" type="submit">Reject request</button>
                </form>
              </li>)}</ul>}
              <p className="muted">Approval is checked against your current recipient limit and access policy. A rejected request creates no grant.</p>
            </section>
          )}
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
            <thead><tr><th scope="col">Preview</th><th scope="col">Title</th><th scope="col">Length</th><th scope="col">Size</th>{permissions.canRequestImport && <th scope="col">Independent copy</th>}</tr></thead>
            <tbody>{videos.map((v) => {
              const job = detail.importJobs?.find((entry) => entry.sourceMediaId === v.id);
              return <tr key={v.id}><td><Thumbnail media={v} /></td><td>{v.title}</td><td>{formatDuration(v.durationMs)}</td><td>{formatStorage(v.sizeBytes)}</td>
                {permissions.canRequestImport && <td>{job ? <>
                  <p>Import {job.status.replaceAll("_", " ")}</p>
                  {job.failureReason && <p className="muted">{job.failureReason}</p>}
                  {job.status === "succeeded" && <a href={`/media/${job.resultMediaAssetId}`}>Open your imported copy</a>}
                  {job.status === "failed" && <form method="post" action="/api/forms/media-import-retry"><input type="hidden" name="jobId" value={job.id} /><input type="hidden" name="collectionId" value={collection.id} /><button type="submit">Retry import</button></form>}
                  <p className="muted">Updated {job.updatedAt.toISOString()}</p>
                </> : <form method="post" action="/api/forms/media-import">
                  <input type="hidden" name="sourceMediaId" value={v.id} /><input type="hidden" name="sourceCollectionId" value={collection.id} />
                  <p><label><input type="checkbox" name="warningAcknowledged" value="yes" required /> I understand this creates a separate copy and uses my storage allowance.</label></p>
                  <button type="submit">Import to my library</button>
                </form>}</td>}
              </tr>;
            })}</tbody></table></div>
        )}
        {permissions.canRequestImport && <p className="muted">The original remains with its owner. Import status means queued, processing, failed or verified complete; a queued job is not an imported copy.</p>}
      </section>
    </>
  );
}
