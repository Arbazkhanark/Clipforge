// // src/components/CollectionViews.tsx
// import type { CollectionCard, CollectionDetail } from "../server/queries.ts";
// import type { CollectionSort } from "../server/library-query.ts";
// import { Thumbnail } from "./MediaTable.tsx";
// import { CAPABILITY_LABELS, VISIBILITY_LABELS, formatCount, formatDuration, formatStorage } from "./format.ts";

// function CollectionList({ collections, emptyText }: { collections: CollectionCard[]; emptyText: string }) {
//   if (collections.length === 0) return <p>{emptyText}</p>;
//   return (
//     <ul className="card-list">
//       {collections.map((c) => (
//         <li key={c.id} className="card" data-collection-id={c.id}>
//           <h3><a href={`/collections/${c.id}`}>{c.name}</a></h3>
//           {c.description && <p>{c.description}</p>}
//           <p className="muted">{formatCount(c.videoCount)} video{c.videoCount === 1 ? "" : "s"} - {VISIBILITY_LABELS[c.visibility]}{c.archived ? " - Archived" : ""}</p>
//           {c.sharedByAnotherUser && <p>You can: {c.capabilities.length ? c.capabilities.map((cap) => CAPABILITY_LABELS[cap]).join(", ") : "nothing yet"}.</p>}
//         </li>
//       ))}
//     </ul>
//   );
// }

// export function CollectionsOverviewView({ owned, sharedWithMe, accessRequests = [], search = "", sort = "newest", filtered = false }: { owned: CollectionCard[]; sharedWithMe: CollectionCard[]; accessRequests?: { id: string; collectionId: string; requestedCapabilities: import("../lib/domain/types.ts").Capability[]; status: "pending" | "approved" | "rejected"; createdAt: Date; decidedAt: Date | null }[]; search?: string; sort?: CollectionSort; filtered?: boolean }) {
//   return (
//     <>
//       <h1>Collections</h1>
//       <form method="get" action="/collections" className="filter-bar" role="search">
//         <p><label>Search collections<br /><input type="search" name="q" defaultValue={search} maxLength={100} /></label></p>
//         <p><label>Sort<br /><select name="sort" defaultValue={sort} aria-label="Sort collections"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option></select></label></p>
//         <p><button type="submit">Apply</button></p>
//       </form>
//       <section aria-labelledby="owned-heading"><h2 id="owned-heading">Your collections</h2><CollectionList collections={owned} emptyText={filtered ? "No collections match that search." : "You have no collections yet."} /></section>
//       <section aria-labelledby="new-collection-heading" className="card">
//         <h2 id="new-collection-heading">New collection</h2>
//         <form method="post" action="/api/forms/collection-create">
//           <p><label>Name<br /><input type="text" name="name" required maxLength={100} /></label></p>
//           <p><label>Description<br /><input type="text" name="description" maxLength={500} /></label></p>
//           <p><label>Who can open it<br /><select name="visibility"><option value="private">Private</option><option value="link">Shared by link</option><option value="public_view">Public (view only)</option></select></label></p>
//           <button type="submit">Create collection</button>
//         </form>
//       </section>
//       <section aria-labelledby="access-request-heading" className="card">
//         <h2 id="access-request-heading">Request collection access</h2>
//         <p>Enter a collection ID you received from its owner. ClipForge will not reveal whether an unknown private collection exists.</p>
//         <form method="post" action="/api/forms/access-request">
//           <p><label>Collection ID<br /><input name="collectionId" required maxLength={64} pattern="[A-Za-z0-9_-]{1,64}" /></label></p>
//           <fieldset><legend>Access requested</legend>
//             {(["view", "use_in_cycle", "import_copy", "download"] as const).map((capability) => <label key={capability} className="checkbox-row"><input type="checkbox" name="requestedCapabilities" value={capability} /> {CAPABILITY_LABELS[capability]}</label>)}
//           </fieldset>
//           <button type="submit">Send access request</button>
//         </form>
//       </section>
//       <section aria-labelledby="my-access-requests-heading">
//         <h2 id="my-access-requests-heading">Your access requests</h2>
//         {accessRequests.length === 0 ? <p>You have no access requests.</p> : <ul className="card-list">{accessRequests.map((request) => <li className="card" key={request.id}><p>Collection ID: <code>{request.collectionId}</code></p><p>Status: {request.status}</p><p>Requested: {request.requestedCapabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}</p><p>Sent: {request.createdAt.toISOString()}{request.decidedAt ? ` — decided ${request.decidedAt.toISOString()}` : ""}</p></li>)}</ul>}
//       </section>
//       <section aria-labelledby="shared-heading"><h2 id="shared-heading">Shared with you</h2><CollectionList collections={sharedWithMe} emptyText={filtered ? "No shared collections match that search." : "Nobody has shared a collection with you."} /></section>
//     </>
//   );
// }

// /** Add videos to one of YOUR cycles. Shared videos are used in place (no copy). The server re-checks every permission. */
// function MixForm({ detail }: { detail: CollectionDetail }) {
//   const { permissions, cycleChoices, videos, collection } = detail;
//   if (!permissions.canUseInCycle) return null;
//   if (cycleChoices.length === 0) return <p className="muted">Create a publishing cycle to add these videos to it.</p>;
//   return (
//     <form method="post" action="/api/forms/cycle-mix" aria-labelledby="mix-heading" className="card">
//       <h2 id="mix-heading">Add videos to a publishing cycle</h2>
//       <input type="hidden" name="collectionId" value={collection.id} />
//       <p><label>Cycle<br /><select name="cycleId" required>{cycleChoices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></p>
//       <fieldset><legend>Videos</legend>
//         {videos.map((v) => <p key={v.id}><label><input type="checkbox" name="video" value={`${collection.id}|${v.id}`} /> {v.title}</label></p>)}
//       </fieldset>
//       {!permissions.isOwner && <p className="muted">These videos stay with their owner: ClipForge uses them in place and does not copy them to your storage.</p>}
//       <button type="submit">Add ticked videos to the cycle</button>
//     </form>
//   );
// }

// export function CollectionDetailView({ detail }: { detail: CollectionDetail }) {
//   const { collection, videos, permissions } = detail;
//   const members = new Set(detail.memberIds ?? []);
//   const shown = new Set(detail.libraryChoices.map((item) => item.id));
//   return (
//     <>
//       <p><a href="/collections">All collections</a></p>
//       <h1>{collection.name}</h1>
//       {collection.description && <p>{collection.description}</p>}
//       <p className="muted">{VISIBILITY_LABELS[collection.visibility]}{collection.sharedByAnotherUser ? " - shared with you by another user" : " - yours"}</p>
//       <section aria-labelledby="perm-heading">
//         <h2 id="perm-heading">What you can do here</h2>
//         <ul>
//           <li>View the videos: yes</li>
//           <li>Use videos in a publishing cycle without copying them: {permissions.canUseInCycle ? "yes" : "no"}</li>
//           <li>Import an independent copy: {permissions.canImport ? "yes" : "no"}</li>
//           <li>Download originals: {permissions.canDownload ? "yes" : "no"}</li>
//         </ul>
//         {!permissions.isOwner && <p className="muted">Permission to use content does not give you rights to redistribute it outside ClipForge.</p>}
//       </section>
//       <MixForm detail={detail} />
//       {permissions.isOwner && (
//         <>
//           {detail.sharingManagement && (
//             <section aria-labelledby="sharing-management-heading" className="card">
//               <h2 id="sharing-management-heading">People with collection access</h2>
//               <p>{detail.sharingManagement.activeRecipients} of {detail.sharingManagement.recipientLimit} recipient slots are in use on this collection. Limits follow your current plan.</p>
//               {detail.sharingManagement.grants.length === 0 ? <p>No direct access grants yet.</p> : (
//                 <ul className="card-list">
//                   {detail.sharingManagement.grants.map((grant) => (
//                     <li key={grant.granteeId} className="card">
//                       <p><strong>User ID:</strong> <code>{grant.granteeId}</code> — {grant.status}</p>
//                       <p>Permissions: {grant.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}</p>
//                       <p>Expires: {grant.expiresAt ? grant.expiresAt.toISOString() : "Never"}</p>
//                       {grant.status === "active" && <form method="post" action="/api/forms/sharing-revoke">
//                         <input type="hidden" name="collectionId" value={collection.id} />
//                         <input type="hidden" name="granteeId" value={grant.granteeId} />
//                         <button type="submit">Revoke access</button>
//                       </form>}
//                     </li>
//                   ))}
//                 </ul>
//               )}
//               {detail.sharingManagement.recipientLimit === 0 ? <p>Your current plan does not include collection sharing.</p> : (
//                 <form method="post" action="/api/forms/sharing-grant">
//                   <input type="hidden" name="collectionId" value={collection.id} />
//                   {detail.sharingManagement.activeRecipients >= detail.sharingManagement.recipientLimit && <p className="muted">The recipient limit is full. The server may still allow updating an existing recipient, but it will reject adding another person.</p>}
//                   <p><label>Recipient user ID<br /><input name="granteeId" required maxLength={64} pattern="[A-Za-z0-9_-]{1,64}" /></label></p>
//                   <fieldset><legend>Permissions to grant</legend>
//                     {(["view", "use_in_cycle", "import_copy", "download"] as const).map((capability) => <label key={capability} className="checkbox-row"><input type="checkbox" name="capabilities" value={capability} /> {CAPABILITY_LABELS[capability]}</label>)}
//                     {detail.sharingManagement.delegatedManagement && <label className="checkbox-row"><input type="checkbox" name="capabilities" value="manage" /> {CAPABILITY_LABELS.manage} (delegated manager; grants expire within 90 days)</label>}
//                   </fieldset>
//                   {detail.sharingManagement.expiringGrants && <p><label>Expiry (ISO date-time with timezone, e.g. 2026-12-01T10:00:00Z)<br /><input name="expiresAt" type="text" maxLength={40} placeholder="Optional" /></label></p>}
//                   <p className="muted">The server checks the recipient, permissions, expiration, delegated-manager rules and current plan limit before saving.</p>
//                   <button type="submit">Grant collection access</button>
//                 </form>
//               )}
//             </section>
//           )}
//           {detail.shareLinks && detail.sharingManagement && (
//             <section aria-labelledby="share-links-heading" className="card">
//               <h2 id="share-links-heading">Secure share links</h2>
//               <p>Share links grant only the permissions shown here. They never grant management access. The full link is shown once when created; stored links below do not reveal it.</p>
//               {detail.shareLinks.length === 0 ? <p>No share links have been created.</p> : <ul className="card-list">{detail.shareLinks.map((link) => <li className="card" key={link.id}>
//                 <p><strong>Link ID:</strong> <code>{link.id}</code> — {link.revokedAt ? "revoked" : link.expiresAt && link.expiresAt <= new Date() ? "expired" : "active"}</p>
//                 <p>Permissions: {link.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}</p>
//                 <p>Expires: {link.expiresAt ? link.expiresAt.toISOString() : "Never"}</p>
//                 <p>Created: {link.createdAt.toISOString()}</p>
//                 {!link.revokedAt && <>
//                   <form method="post" action="/api/forms/share-link-update">
//                     <input type="hidden" name="collectionId" value={collection.id} /><input type="hidden" name="shareLinkId" value={link.id} />
//                     <fieldset><legend>Update link permissions</legend>
//                       {(["view", "import_copy", "download"] as const).map((capability) => <label key={capability} className="checkbox-row"><input type="checkbox" name="capabilities" value={capability} defaultChecked={link.capabilities.includes(capability)} /> {CAPABILITY_LABELS[capability]}</label>)}
//                     </fieldset>
//                     <p className="muted">Publishing-cycle use must be granted directly by the collection owner.</p>
//                     {detail.sharingManagement?.expiringGrants && <p><label>Expiry (ISO date-time; leave blank for no expiry)<br /><input name="expiresAt" type="text" maxLength={40} defaultValue={link.expiresAt?.toISOString() ?? ""} /></label></p>}
//                     <button type="submit">Save link permissions</button>
//                   </form>
//                   <form method="post" action="/api/forms/share-link-revoke">
//                     <input type="hidden" name="collectionId" value={collection.id} /><input type="hidden" name="shareLinkId" value={link.id} />
//                     <button type="submit">Revoke link</button>
//                   </form>
//                 </>}
//               </li>)}</ul>}
//               {detail.sharingManagement.recipientLimit === 0 ? <p>Your current plan does not include collection sharing.</p> : collection.visibility !== "link" || collection.archived ? <p>Set this collection to link visibility and make it active before creating a share link.</p> : <form method="post" action="/api/forms/share-link-create">
//                 <input type="hidden" name="collectionId" value={collection.id} />
//                 <fieldset><legend>Permissions for the new link</legend>
//                   {(["view", "import_copy", "download"] as const).map((capability) => <label key={capability} className="checkbox-row"><input type="checkbox" name="capabilities" value={capability} defaultChecked={capability === "view"} required={capability === "view"} /> {CAPABILITY_LABELS[capability]}</label>)}
//                 </fieldset>
//                 <p className="muted">Publishing-cycle use must be granted directly by the collection owner.</p>
//                 {detail.sharingManagement.expiringGrants && <p><label>Expiry (ISO date-time; leave blank for no expiry)<br /><input name="expiresAt" type="text" maxLength={40} placeholder="Optional" /></label></p>}
//                 <p className="muted">The server checks your current plan and collection state. Link permissions are rechecked on every visit and action.</p>
//                 <button type="submit">Create one-time share link</button>
//               </form>}
//             </section>
//           )}
//           {detail.pendingAccessRequests && (
//             <section aria-labelledby="pending-requests-heading" className="card">
//               <h2 id="pending-requests-heading">Pending access requests</h2>
//               {detail.pendingAccessRequests.length === 0 ? <p>No pending requests.</p> : <ul className="card-list">{detail.pendingAccessRequests.map((request) => <li className="card" key={request.id}>
//                 <p>Requester user ID: <code>{request.requesterId}</code></p>
//                 <p>Requested: {request.requestedCapabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}</p>
//                 <p>Sent: {request.createdAt.toISOString()}</p>
//                 <form method="post" action="/api/forms/access-request-decision">
//                   <input type="hidden" name="collectionId" value={collection.id} /><input type="hidden" name="requestId" value={request.id} />
//                   <button name="decision" value="approved" type="submit">Approve requested access</button>{" "}<button name="decision" value="rejected" type="submit">Reject request</button>
//                 </form>
//               </li>)}</ul>}
//               <p className="muted">Approval is checked against your current recipient limit and access policy. A rejected request creates no grant.</p>
//             </section>
//           )}
//           <section aria-labelledby="edit-collection-heading" className="card">
//             <h2 id="edit-collection-heading">Collection details</h2>
//             <form method="post" action="/api/forms/collection-update">
//               <input type="hidden" name="collectionId" value={collection.id} />
//               <p><label>Name<br /><input type="text" name="name" required maxLength={100} defaultValue={collection.name} /></label></p>
//               <p><label>Description<br /><input type="text" name="description" maxLength={500} defaultValue={collection.description ?? ""} /></label></p>
//               <p><label>Who can open it<br /><select name="visibility" defaultValue={collection.visibility}><option value="private">Private</option><option value="link">Shared by link</option><option value="public_view">Public (view only)</option></select></label></p>
//               <button type="submit">Save collection</button>
//             </form>
//           </section>
//           <section aria-labelledby="membership-heading" className="card">
//             <h2 id="membership-heading">Files in this collection</h2>
//             <p className="muted">The same file can belong to more than one collection. Taking it out of this list does not delete the original, and it stays in every other collection.</p>
//             {detail.libraryChoices.length === 0 ? <p>Upload a file in the <a href="/media">media library</a> before adding it here.</p> : (
//               <form method="post" action="/api/forms/collection-media">
//                 <input type="hidden" name="collectionId" value={collection.id} />
//                 {(detail.memberIds ?? []).filter((id) => !shown.has(id)).map((id) => <input key={id} type="hidden" name="mediaIds" value={id} />)}
//                 {detail.libraryChoices.map((item) => <p key={item.id}><label><input type="checkbox" name="mediaIds" value={item.id} defaultChecked={members.has(item.id)} /> {item.title}</label></p>)}
//                 {detail.libraryTruncated && <p className="muted">Only the first 200 files by name are listed here.</p>}
//                 <button type="submit">Save this list</button>
//               </form>
//             )}
//           </section>
//           <section aria-labelledby="danger-heading" className="card">
//             <h2 id="danger-heading">Archive or delete</h2>
//             <p>These actions change the collection only. They do not delete videos from your library.</p>
//             <form method="post" action="/api/forms/collection-archive">
//               <input type="hidden" name="collectionId" value={collection.id} />
//               <input type="hidden" name="archived" value={collection.archived ? "no" : "yes"} />
//               <p><label><input type="checkbox" name="confirm" value="yes" required /> {collection.archived ? "Restore this collection. The videos stay where they are." : "Archive this collection. The videos stay in the library."}</label></p>
//               <button type="submit">{collection.archived ? "Restore collection" : "Archive collection"}</button>
//             </form>
//             <form method="post" action="/api/forms/collection-delete">
//               <input type="hidden" name="collectionId" value={collection.id} />
//               <p><label><input type="checkbox" name="confirm" value="yes" required /> Delete this collection. The videos stay in the library and in every other collection.</label></p>
//               <button type="submit">Delete collection</button>
//             </form>
//           </section>
//         </>
//       )}
//       <section aria-labelledby="videos-heading">
//         <h2 id="videos-heading">Videos</h2>
//         <form method="get" action={`/collections/${collection.id}`} className="filter-bar" role="search">
//           <p><label>Search videos<br /><input type="search" name="q" defaultValue={detail.videoSearch ?? ""} maxLength={100} /></label></p>
//           <p><label>Sort<br /><select name="sort" defaultValue={detail.videoSort ?? "newest"} aria-label="Sort videos in this collection"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option><option value="size">Size</option></select></label></p>
//           <p><button type="submit">Apply</button></p>
//         </form>
//         {videos.length === 0 ? <p>{detail.videoFiltered ? "No videos in this collection match that search." : "This collection has no videos."}</p> : (
//           <div className="table-scroll"><table className="data-table"><caption>Videos in this collection</caption>
//             <thead><tr><th scope="col">Preview</th><th scope="col">Title</th><th scope="col">Length</th><th scope="col">Size</th>{permissions.canRequestImport && <th scope="col">Independent copy</th>}</tr></thead>
//             <tbody>{videos.map((v) => {
//               const job = detail.importJobs?.find((entry) => entry.sourceMediaId === v.id);
//               return <tr key={v.id}><td><Thumbnail media={v} /></td><td>{v.title}</td><td>{formatDuration(v.durationMs)}</td><td>{formatStorage(v.sizeBytes)}</td>
//                 {permissions.canRequestImport && <td>{job ? <>
//                   <p>Import {job.status.replaceAll("_", " ")}</p>
//                   {job.failureReason && <p className="muted">{job.failureReason}</p>}
//                   {job.status === "succeeded" && <a href={`/media/${job.resultMediaAssetId}`}>Open your imported copy</a>}
//                   {job.status === "failed" && <form method="post" action="/api/forms/media-import-retry"><input type="hidden" name="jobId" value={job.id} /><input type="hidden" name="collectionId" value={collection.id} /><button type="submit">Retry import</button></form>}
//                   <p className="muted">Updated {job.updatedAt.toISOString()}</p>
//                 </> : <form method="post" action="/api/forms/media-import">
//                   <input type="hidden" name="sourceMediaId" value={v.id} /><input type="hidden" name="sourceCollectionId" value={collection.id} />
//                   <p><label><input type="checkbox" name="warningAcknowledged" value="yes" required /> I understand this creates a separate copy and uses my storage allowance.</label></p>
//                   <button type="submit">Import to my library</button>
//                 </form>}</td>}
//               </tr>;
//             })}</tbody></table></div>
//         )}
//         {permissions.canRequestImport && <p className="muted">The original remains with its owner. Import status means queued, processing, failed or verified complete; a queued job is not an imported copy.</p>}
//       </section>
//     </>
//   );
// }

























import type { CollectionCard, CollectionDetail, MediaCard } from "../server/queries.ts";
import type { CollectionSort } from "../server/library-query.ts";
import type { Capability } from "../lib/domain/types.ts";
import { Thumbnail } from "./MediaTable.tsx";
import { CollectionCreateDialog } from "./CollectionCreateDialog.tsx";
import { CollectionCaptionCoverEditor } from "./CollectionCaptionCoverEditor.tsx";
import { CollectionVideoRemoveAction } from "./CollectionVideoRemoveAction.tsx";
import { CollectionVideoPreview } from "./CollectionVideoPreview.tsx";
import { UploadForm } from "./UploadForm.tsx";
import {
  CAPABILITY_LABELS,
  VISIBILITY_LABELS,
  formatCount,
  formatDuration,
  formatStorage,
} from "./format.ts";

type AccessRequest = {
  id: string;
  collectionId: string;
  requestedCapabilities: Capability[];
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
  decidedAt: Date | null;
};

const CAPABILITIES = ["view", "use_in_cycle", "import_copy", "download"] as const;

function SectionHeading({
  eyebrow,
  title,
  description,
  count,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  count?: number;
}) {
  return (
    <div className="collection-section-heading">
      <div>
        {eyebrow && <span className="collection-eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {count !== undefined && (
        <span className="collection-count">{count}</span>
      )}
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="collection-empty">
      <div className="collection-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M8 9h8M8 13h5" />
        </svg>
      </div>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function CollectionList({
  collections,
  emptyText,
}: {
  collections: CollectionCard[];
  emptyText: string;
}) {
  if (collections.length === 0) {
    return (
      <EmptyState
        title={emptyText}
        description="Collections shared or created in the future will appear here."
      />
    );
  }

  return (
    <div className="collection-card-grid">
      {collections.map((collection) => (
        <article
          key={collection.id}
          className="collection-item-card"
          data-collection-id={collection.id}
        >
          <a className="collection-card-preview" href={`/collections/${collection.id}`} aria-label={`Open ${collection.name}`}>
            {collection.previewMediaId ? <Thumbnail media={{ id: collection.previewMediaId, hasThumbnail: true, kind: "video" }} /> : <div className="collection-card-placeholder" aria-hidden="true"><span>▱</span></div>}
          </a>
          <div className="collection-item-top">
            <span className={`collection-visibility collection-visibility-${collection.visibility}`}>
              {VISIBILITY_LABELS[collection.visibility]}
            </span>
          </div>

          <h3>
            <a href={`/collections/${collection.id}`}>{collection.name}</a>
          </h3>

          <p className="collection-item-description">
            {collection.description || "No description added."}
          </p>

          <div className="collection-item-meta">
            <span>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2.5" y="4" width="15" height="12" rx="2" />
                <path d="m8 8 5 2-5 2V8Z" />
              </svg>
              {formatCount(collection.videoCount)} videos
            </span>
            {collection.createdAt && <span>Created {collection.createdAt.toLocaleDateString()}</span>}
            {collection.archived && (
              <span className="collection-archived-label">Archived</span>
            )}
          </div>

          {collection.sharedByAnotherUser && (
            <div className="collection-permission-note">
              <span>Shared collection</span>
              <p>
                {collection.capabilities.length
                  ? collection.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")
                  : "View only"}
              </p>
            </div>
          )}

          <div className="collection-card-actions">
            <a className="collection-open-link" href={`/collections/${collection.id}`}>Open collection <span aria-hidden="true">→</span></a>
            <details className="collection-card-menu">
              <summary aria-label={`More actions for ${collection.name}`}>•••</summary>
              <div>
                <a href={`/collections/${collection.id}`}>Open</a>
                {!collection.sharedByAnotherUser && <>
                  <a href={`/collections/${collection.id}#collection-settings`}>Edit details</a>
                  <a href={`/collections/${collection.id}#sharing-management`}>Manage sharing</a>
                  <a href={`/collections/${collection.id}#collection-danger-zone`}>Delete collection</a>
                </>}
                {collection.sharedByAnotherUser && <span>Actions are limited by your access.</span>}
              </div>
            </details>
          </div>
        </article>
      ))}
    </div>
  );
}

export function CollectionsOverviewView({
  owned,
  sharedWithMe,
  accessRequests = [],
  search = "",
  sort = "newest",
  filtered = false,
  libraryChoices = [],
  incomingAccessRequests = [],
  tab = "mine",
}: {
  owned: CollectionCard[];
  sharedWithMe: CollectionCard[];
  accessRequests?: AccessRequest[];
  search?: string;
  sort?: CollectionSort;
  filtered?: boolean;
  libraryChoices?: MediaCard[];
  incomingAccessRequests?: { id: string; collectionId: string; collectionName: string; requesterId: string; requestedCapabilities: Capability[]; createdAt: Date }[];
  tab?: "mine" | "shared" | "requests";
}) {
  const tabHref = (nextTab: "mine" | "shared" | "requests") => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (sort !== "newest") params.set("sort", sort);
    params.set("tab", nextTab);
    return `/collections?${params.toString()}`;
  };
  const visibleCollections = tab === "shared" ? sharedWithMe : owned;
  const visibleLabel = tab === "shared" ? "Shared with me" : "My collections";
  const sharedNames = new Map(sharedWithMe.map((collection) => [collection.id, collection.name]));
  return (
    <main className="collections-page">
      <header className="collections-page-header">
        <div>
          <span className="collection-eyebrow">YOUR WORKSPACE</span>
          <h1>Collections</h1>
          <p>Organize your media and manage content shared with you.</p>
        </div>

        <CollectionCreateDialog libraryChoices={libraryChoices} />
      </header>

      <nav className="collection-tabs" aria-label="Collections sections">
        <a href={tabHref("mine")} aria-current={tab === "mine" ? "page" : undefined}>My Collections <span>{owned.length}</span></a>
        <a href={tabHref("shared")} aria-current={tab === "shared" ? "page" : undefined}>Shared with Me <span>{sharedWithMe.length}</span></a>
        <a href={tabHref("requests")} aria-current={tab === "requests" ? "page" : undefined}>Access Requests <span>{incomingAccessRequests.length + accessRequests.filter((request) => request.status === "pending").length}</span></a>
      </nav>

      {tab !== "requests" && <section className="collection-toolbar">
        <form method="get" action="/collections" className="collection-filter-form" role="search">
          <input type="hidden" name="tab" value={tab} />
          <label className="collection-search-field">
            <span className="sr-only">Search collections</span>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4 4" />
            </svg>
            <input
              type="search"
              name="q"
              defaultValue={search}
              maxLength={100}
              placeholder="Search your collections..."
            />
          </label>

          <label className="collection-sort-field">
            <span className="sr-only">Sort collections</span>
            <select name="sort" defaultValue={sort} aria-label="Sort collections">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name</option>
            </select>
          </label>

          <button type="submit" className="collection-filter-button">
            Apply
          </button>
        </form>
      </section>}

      {tab !== "requests" ? <section className="collection-overview-section">
        <SectionHeading
          eyebrow={tab === "shared" ? "COLLABORATION" : "PERSONAL LIBRARY"}
          title={visibleLabel}
          description={tab === "shared" ? "Collections other people have shared with you." : "Collections you have created and manage."}
          count={visibleCollections.length}
        />

        <CollectionList
          collections={visibleCollections}
          emptyText={
            filtered
              ? `No ${tab === "shared" ? "shared " : ""}collections match your search`
              : tab === "shared" ? "No collections have been shared with you yet" : "You haven't created any collections yet"
          }
        />
      </section> : <section className="collection-requests-page">
        <div className="collection-request-columns">
          <section className="collection-request-group" aria-labelledby="incoming-requests-heading">
            <div className="collection-request-group-heading"><div><span className="collection-eyebrow">OWNER WORKSPACE</span><h2 id="incoming-requests-heading">Incoming requests</h2><p>Requests to access collections you own.</p></div><span className="collection-count">{incomingAccessRequests.length}</span></div>
            {incomingAccessRequests.length === 0 ? <EmptyState title="No incoming requests" description="New requests for your collections will appear here." /> : <div className="collection-request-grid">
              {incomingAccessRequests.map((request) => <article className="collection-request-card" key={request.id}>
                <div className="collection-request-top"><span className="collection-request-label">{request.collectionName}</span><span className="collection-status collection-status-pending">Pending</span></div>
                <p className="collection-request-id">Requester <code>{request.requesterId}</code></p>
                <div className="collection-request-permissions"><span>Requested permissions</span><p>{request.requestedCapabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}</p></div>
                <p className="collection-form-hint">Received {request.createdAt.toLocaleDateString()}</p>
                <form method="post" action="/api/forms/access-request-decision" className="collection-decision-actions">
                  <input type="hidden" name="collectionId" value={request.collectionId} /><input type="hidden" name="requestId" value={request.id} />
                  <button name="decision" value="approved" type="submit" className="collection-primary-button">Approve</button>
                  <button name="decision" value="rejected" type="submit" className="collection-danger-button">Reject</button>
                </form>
              </article>)}
            </div>}
          </section>
          <section className="collection-request-group" aria-labelledby="outgoing-requests-heading">
            <div className="collection-request-group-heading"><div><span className="collection-eyebrow">YOUR REQUESTS</span><h2 id="outgoing-requests-heading">Outgoing requests</h2><p>Track requests you have sent.</p></div><span className="collection-count">{accessRequests.length}</span></div>
            <form method="post" action="/api/forms/access-request" className="collection-access-form collection-request-form">
              <label className="collection-form-field"><span>Collection ID</span><input name="collectionId" required maxLength={64} pattern="[A-Za-z0-9_-]{1,64}" placeholder="Paste a collection ID" /></label>
              <fieldset className="collection-capability-fieldset"><legend>Request permissions</legend><div className="collection-checkbox-grid">{CAPABILITIES.map((capability) => <label key={capability} className="collection-checkbox"><input type="checkbox" name="requestedCapabilities" value={capability} /><span>{CAPABILITY_LABELS[capability]}</span></label>)}</div></fieldset>
              <p className="collection-form-hint">Unknown private collections stay indistinguishable from unavailable ones.</p>
              <button type="submit" className="collection-secondary-button">Send request</button>
            </form>
            {accessRequests.length === 0 ? <EmptyState title="No outgoing requests" description="Requests you send will appear here with their current status." /> : <div className="collection-request-grid">
              {accessRequests.map((request) => (
              <article className="collection-request-card" key={request.id}>
                <div className="collection-request-top">
                  <span className="collection-request-label">{sharedNames.get(request.collectionId) ?? "Collection request"}</span>
                  <span className={`collection-status collection-status-${request.status}`}>
                    {request.status}
                  </span>
                </div>

                <p className="collection-request-id">
                  ID: <code>{request.collectionId}</code>
                </p>

                <div className="collection-request-permissions">
                  <span>Requested permissions</span>
                  <p>
                    {request.requestedCapabilities
                      .map((capability) => CAPABILITY_LABELS[capability])
                      .join(", ")}
                  </p>
                </div>

                <div className="collection-request-dates">
                  <span>Sent {request.createdAt.toLocaleDateString()}</span>
                  {request.decidedAt && (
                    <span>Decided {request.decidedAt.toLocaleDateString()}</span>
                  )}
                </div>
              </article>
            ))}
            </div>}
          </section>
        </div>
      </section>
      }
    </main>
  );
}

/** Add videos to one of YOUR cycles. Shared videos are used in place (no copy). */
function MixForm({ detail }: { detail: CollectionDetail }) {
  const { permissions, cycleChoices, videos, collection } = detail;

  if (!permissions.canUseInCycle) return null;

  if (cycleChoices.length === 0) {
    return (
      <div className="collection-inline-notice">
        Create a publishing cycle first to add these videos to it.
      </div>
    );
  }

  return (
    <section id="add-to-cycle" className="collection-panel">
      <SectionHeading
        eyebrow="PUBLISHING"
        title="Add videos to a cycle"
        description="Use videos from this collection in one of your publishing cycles."
      />

      <form method="post" action="/api/forms/cycle-mix" className="collection-detail-form">
        <input type="hidden" name="collectionId" value={collection.id} />

        <label className="collection-form-field">
          <span>Choose publishing cycle</span>
          <select name="cycleId" required>
            {cycleChoices.map((cycle) => (
              <option key={cycle.id} value={cycle.id}>{cycle.name}</option>
            ))}
          </select>
        </label>

        <fieldset className="collection-capability-fieldset">
          <legend>Select videos</legend>
          <div className="collection-video-select-list">
            {videos.map((video) => (
              <label className="collection-video-select" key={video.id}>
                <input
                  type="checkbox"
                  name="video"
                  value={`${collection.id}|${video.id}`}
                />
                <span>{video.title}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {!permissions.isOwner && (
          <p className="collection-form-hint">
            These videos stay with their owner. ClipForge uses them in place and does not copy them to your storage.
          </p>
        )}

        <button type="submit" className="collection-primary-button">
          Add selected videos
        </button>
      </form>
    </section>
  );
}

function PermissionOverview({ detail }: { detail: CollectionDetail }) {
  const { permissions } = detail;

  const items = [
    { label: "View videos", allowed: true },
    { label: "Use in publishing cycles", allowed: permissions.canUseInCycle },
    { label: "Import an independent copy", allowed: permissions.canImport },
    { label: "Download originals", allowed: permissions.canDownload },
  ];

  return (
    <section className="collection-permission-panel">
      <SectionHeading
        title="Your permissions"
        description="What you can do with the content in this collection."
      />

      <div className="collection-permission-grid">
        {items.map((item) => (
          <div className="collection-permission-item" key={item.label}>
            <span className={item.allowed ? "permission-allowed" : "permission-denied"}>
              {item.allowed ? "✓" : "—"}
            </span>
            <span>{item.label}</span>
          </div>
        ))}
      </div>

      {!permissions.isOwner && (
        <p className="collection-form-hint">
          Permission to use content does not give you rights to redistribute it outside ClipForge.
        </p>
      )}
    </section>
  );
}

function SharingManagement({ detail }: { detail: CollectionDetail }) {
  const { collection, sharingManagement } = detail;
  if (!sharingManagement) return null;

  return (
    <section id="sharing-management" className="collection-panel">
      <SectionHeading
        eyebrow="ACCESS CONTROL"
        title="People with collection access"
        description="Manage who can access this collection and what they can do."
      />

      <div className="collection-usage-limit">
        <div>
          <strong>{sharingManagement.activeRecipients} / {sharingManagement.recipientLimit}</strong>
          <span>Recipient slots used</span>
        </div>
        <p>Limits follow your current plan.</p>
      </div>

      {sharingManagement.grants.length === 0 ? (
        <EmptyState
          title="No direct access grants"
          description="People you give collection access to will appear here."
        />
      ) : (
        <div className="collection-management-list">
          {sharingManagement.grants.map((grant) => (
            <article className="collection-management-card" key={grant.granteeId}>
              <div className="collection-management-card-top">
                <div>
                  <span className="collection-eyebrow">USER ID</span>
                  <code>{grant.granteeId}</code>
                </div>
                <span className={`collection-status collection-status-${grant.status}`}>
                  {grant.status}
                </span>
              </div>

              <p>
                <strong>Permissions:</strong>{" "}
                {grant.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}
              </p>

              <p className="collection-form-hint">
                Expires: {grant.expiresAt ? grant.expiresAt.toISOString() : "Never"}
              </p>

              {grant.status === "active" && (
                <form method="post" action="/api/forms/sharing-revoke">
                  <input type="hidden" name="collectionId" value={collection.id} />
                  <input type="hidden" name="granteeId" value={grant.granteeId} />
                  <button type="submit" className="collection-danger-button">
                    Revoke access
                  </button>
                </form>
              )}
            </article>
          ))}
        </div>
      )}

      {sharingManagement.recipientLimit === 0 ? (
        <p className="collection-inline-notice">
          Your current plan does not include collection sharing.
        </p>
      ) : (
        <div className="collection-subsection">
          <h3>Grant access to someone</h3>
          {sharingManagement.activeRecipients >= sharingManagement.recipientLimit && (
            <p className="collection-inline-notice">
              The recipient limit is full. The server may still allow updating an existing recipient, but it will reject adding another person.
            </p>
          )}

          <form method="post" action="/api/forms/sharing-grant" className="collection-detail-form">
            <input type="hidden" name="collectionId" value={collection.id} />

            <label className="collection-form-field">
              <span>Recipient user ID</span>
              <input
                name="granteeId"
                required
                maxLength={64}
                pattern="[A-Za-z0-9_-]{1,64}"
                placeholder="Enter recipient user ID"
              />
            </label>

            <fieldset className="collection-capability-fieldset">
              <legend>Permissions to grant</legend>
              <div className="collection-checkbox-grid">
                {CAPABILITIES.map((capability) => (
                  <label className="collection-checkbox" key={capability}>
                    <input type="checkbox" name="capabilities" value={capability} />
                    <span>{CAPABILITY_LABELS[capability]}</span>
                  </label>
                ))}

                {sharingManagement.delegatedManagement && (
                  <label className="collection-checkbox">
                    <input type="checkbox" name="capabilities" value="manage" />
                    <span>
                      {CAPABILITY_LABELS.manage} (delegated manager; grants expire within 90 days)
                    </span>
                  </label>
                )}
              </div>
            </fieldset>

            {sharingManagement.expiringGrants && (
              <label className="collection-form-field">
                <span>Expiry date (optional)</span>
                <input
                  name="expiresAt"
                  type="text"
                  maxLength={40}
                  placeholder="2026-12-01T10:00:00Z"
                />
              </label>
            )}

            <p className="collection-form-hint">
              The server checks recipient, permissions, expiration, delegated-manager rules and your plan limit.
            </p>

            <button type="submit" className="collection-primary-button">
              Grant collection access
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

function ShareLinks({ detail }: { detail: CollectionDetail }) {
  const { collection, shareLinks, sharingManagement } = detail;
  if (!shareLinks || !sharingManagement) return null;

  return (
    <section id="share-links" className="collection-panel">
      <SectionHeading
        eyebrow="LINK SHARING"
        title="Secure share links"
        description="Create and manage links with limited collection permissions."
      />

      <p className="collection-form-hint">
        A full link is shown only once when created. Stored links below do not reveal it. Share links never grant management access.
      </p>

      {shareLinks.length === 0 ? (
        <EmptyState
          title="No share links yet"
          description="Create a link to let others access this collection."
        />
      ) : (
        <div className="collection-management-list">
          {shareLinks.map((link) => {
            const expired = link.expiresAt && link.expiresAt <= new Date();
            const status = link.revokedAt ? "revoked" : expired ? "expired" : "active";

            return (
              <article className="collection-management-card" key={link.id}>
                <div className="collection-management-card-top">
                  <div>
                    <span className="collection-eyebrow">LINK ID</span>
                    <code>{link.id}</code>
                  </div>
                  <span className={`collection-status collection-status-${status}`}>
                    {status}
                  </span>
                </div>

                <p>
                  <strong>Permissions:</strong>{" "}
                  {link.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}
                </p>

                <p className="collection-form-hint">
                  Expires: {link.expiresAt ? link.expiresAt.toISOString() : "Never"}
                </p>
                <p className="collection-form-hint">
                  Created: {link.createdAt.toISOString()}
                </p>

                {!link.revokedAt && (
                  <div className="collection-management-actions">
                    <form method="post" action="/api/forms/share-link-update" className="collection-detail-form">
                      <input type="hidden" name="collectionId" value={collection.id} />
                      <input type="hidden" name="shareLinkId" value={link.id} />

                      <fieldset className="collection-capability-fieldset">
                        <legend>Update link permissions</legend>
                        <div className="collection-checkbox-grid">
                          {(["view", "import_copy", "download"] as const).map((capability) => (
                            <label className="collection-checkbox" key={capability}>
                              <input
                                type="checkbox"
                                name="capabilities"
                                value={capability}
                                defaultChecked={link.capabilities.includes(capability)}
                              />
                              <span>{CAPABILITY_LABELS[capability]}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <p className="collection-form-hint">
                        Publishing-cycle use must be granted directly by the collection owner.
                      </p>

                      {sharingManagement.expiringGrants && (
                        <label className="collection-form-field">
                          <span>Expiry (optional)</span>
                          <input
                            name="expiresAt"
                            type="text"
                            maxLength={40}
                            defaultValue={link.expiresAt?.toISOString() ?? ""}
                          />
                        </label>
                      )}

                      <button type="submit" className="collection-secondary-button">
                        Save link permissions
                      </button>
                    </form>

                    <form method="post" action="/api/forms/share-link-revoke">
                      <input type="hidden" name="collectionId" value={collection.id} />
                      <input type="hidden" name="shareLinkId" value={link.id} />
                      <button type="submit" className="collection-danger-button">
                        Revoke link
                      </button>
                    </form>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <div className="collection-subsection">
        <h3>Create a new share link</h3>

        {sharingManagement.recipientLimit === 0 ? (
          <p className="collection-inline-notice">
            Your current plan does not include collection sharing.
          </p>
        ) : collection.visibility !== "link" || collection.archived ? (
          <p className="collection-inline-notice">
            Set this collection to link visibility and make it active before creating a share link.
          </p>
        ) : (
          <form method="post" action="/api/forms/share-link-create" className="collection-detail-form">
            <input type="hidden" name="collectionId" value={collection.id} />

            <fieldset className="collection-capability-fieldset">
              <legend>Permissions for the new link</legend>
              <div className="collection-checkbox-grid">
                {(["view", "import_copy", "download"] as const).map((capability) => (
                  <label className="collection-checkbox" key={capability}>
                    <input
                      type="checkbox"
                      name="capabilities"
                      value={capability}
                      defaultChecked={capability === "view"}
                      required={capability === "view"}
                    />
                    <span>{CAPABILITY_LABELS[capability]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <p className="collection-form-hint">
              Publishing-cycle use must be granted directly by the collection owner.
            </p>

            {sharingManagement.expiringGrants && (
              <label className="collection-form-field">
                <span>Expiry (optional)</span>
                <input
                  name="expiresAt"
                  type="text"
                  maxLength={40}
                  placeholder="Optional"
                />
              </label>
            )}

            <p className="collection-form-hint">
              The server checks your current plan and collection state. Link permissions are rechecked on every visit and action.
            </p>

            <button type="submit" className="collection-primary-button">
              Create one-time share link
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

function PendingAccessRequests({ detail }: { detail: CollectionDetail }) {
  const { collection, pendingAccessRequests } = detail;
  if (!pendingAccessRequests) return null;

  return (
    <section className="collection-panel">
      <SectionHeading
        eyebrow="INCOMING REQUESTS"
        title="Pending access requests"
        description="Review requests from people who want access to this collection."
        count={pendingAccessRequests.length}
      />

      {pendingAccessRequests.length === 0 ? (
        <EmptyState
          title="No pending requests"
          description="New access requests will appear here."
        />
      ) : (
        <div className="collection-management-list">
          {pendingAccessRequests.map((request) => (
            <article className="collection-management-card" key={request.id}>
              <span className="collection-eyebrow">REQUESTER USER ID</span>
              <code>{request.requesterId}</code>

              <p>
                <strong>Requested:</strong>{" "}
                {request.requestedCapabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ")}
              </p>

              <p className="collection-form-hint">
                Sent: {request.createdAt.toISOString()}
              </p>

              <form method="post" action="/api/forms/access-request-decision" className="collection-decision-actions">
                <input type="hidden" name="collectionId" value={collection.id} />
                <input type="hidden" name="requestId" value={request.id} />
                <button name="decision" value="approved" type="submit" className="collection-primary-button">
                  Approve
                </button>
                <button name="decision" value="rejected" type="submit" className="collection-danger-button">
                  Reject
                </button>
              </form>
            </article>
          ))}
        </div>
      )}

      <p className="collection-form-hint">
        Approval is checked against your current recipient limit and access policy. A rejected request creates no grant.
      </p>
    </section>
  );
}

function CollectionSettings({ detail }: { detail: CollectionDetail }) {
  const { collection } = detail;

  return (
    <>
      <section id="collection-settings" className="collection-panel">
        <SectionHeading
          eyebrow="SETTINGS"
          title="Collection details"
          description="Update the name, description and visibility of this collection."
        />

        <form method="post" action="/api/forms/collection-update" className="collection-detail-form">
          <input type="hidden" name="collectionId" value={collection.id} />

          <label className="collection-form-field">
            <span>Collection name</span>
            <input
              type="text"
              name="name"
              required
              maxLength={100}
              defaultValue={collection.name}
            />
          </label>

          <label className="collection-form-field">
            <span>Description</span>
            <input
              type="text"
              name="description"
              maxLength={500}
              defaultValue={collection.description ?? ""}
            />
          </label>

          <label className="collection-form-field">
            <span>Visibility</span>
            <select name="visibility" defaultValue={collection.visibility}>
              <option value="private">Private</option>
              <option value="link">Shared by link</option>
              <option value="public_view">Public (view only)</option>
            </select>
          </label>

          <button type="submit" className="collection-primary-button">
            Save changes
          </button>
        </form>
      </section>

      <section className="collection-panel">
        <SectionHeading
          eyebrow="MEDIA ORGANIZATION"
          title="Files in this collection"
          description="Add or remove files without deleting the original media from your library."
        />

        <p className="collection-form-hint">
          The same file can belong to more than one collection. Removing it here does not delete the original or remove it from other collections.
        </p>

        {detail.libraryChoices.length === 0 ? (
          <EmptyState
            title="No library files available"
            description="Upload a file in your media library before adding it to this collection."
          />
        ) : (
          <form method="post" action="/api/forms/collection-media" className="collection-detail-form">
            <input type="hidden" name="collectionId" value={collection.id} />

            {(detail.memberIds ?? [])
              .filter((id) => !new Set(detail.libraryChoices.map((item) => item.id)).has(id))
              .map((id) => (
                <input key={id} type="hidden" name="mediaIds" value={id} />
              ))}

            <div className="collection-library-choice-list">
              {detail.libraryChoices.map((item) => (
                <label className="collection-library-choice" key={item.id}>
                  <input
                    type="checkbox"
                    name="mediaIds"
                    value={item.id}
                    defaultChecked={(detail.memberIds ?? []).includes(item.id)}
                  />
                  <span>{item.title}</span>
                </label>
              ))}
            </div>

            {detail.libraryTruncated && (
              <p className="collection-form-hint">
                Only the first 200 files by name are listed here.
              </p>
            )}

            <button type="submit" className="collection-primary-button">
              Save collection files
            </button>
          </form>
        )}
      </section>

      <section id="collection-danger-zone" className="collection-danger-panel">
        <SectionHeading
          eyebrow="DANGER ZONE"
          title="Archive or delete"
          description="These actions affect the collection only. Your original media files will not be deleted."
        />

        <div className="collection-danger-action">
          <div>
            <h3>{collection.archived ? "Restore collection" : "Archive collection"}</h3>
            <p>
              {collection.archived
                ? "Make this collection active again."
                : "Hide this collection from active use. Its videos remain in your library."}
            </p>
          </div>

          <form method="post" action="/api/forms/collection-archive">
            <input type="hidden" name="collectionId" value={collection.id} />
            <input
              type="hidden"
              name="archived"
              value={collection.archived ? "no" : "yes"}
            />
            <label className="collection-confirm-checkbox">
              <input type="checkbox" name="confirm" value="yes" required />
              <span>I confirm this action</span>
            </label>
            <button type="submit" className="collection-secondary-button">
              {collection.archived ? "Restore collection" : "Archive collection"}
            </button>
          </form>
        </div>

        <div className="collection-danger-action">
          <div>
            <h3>Delete collection</h3>
            <p>
              Permanently delete this collection. The videos remain in your library and other collections.
            </p>
          </div>

          <form method="post" action="/api/forms/collection-delete">
            <input type="hidden" name="collectionId" value={collection.id} />
            <label className="collection-confirm-checkbox">
              <input type="checkbox" name="confirm" value="yes" required />
              <span>I understand this cannot be undone</span>
            </label>
            <button type="submit" className="collection-danger-button">
              Delete collection
            </button>
          </form>
        </div>
      </section>
    </>
  );
}

function CollectionVideos({ detail }: { detail: CollectionDetail }) {
  const { collection, videos, permissions } = detail;

  return (
    <section id="collection-videos" className="collection-videos-section">
      <SectionHeading
        eyebrow="COLLECTION CONTENT"
        title="Videos"
        description="Browse and manage the videos included in this collection."
        count={videos.length}
      />

      {permissions.isOwner && !collection.archived && detail.uploadInfo && (
        <div className="collection-direct-upload">
          <h3>Upload directly to this collection</h3>
          <p>Each uploaded file is added to your library and this collection in one confirmed save.</p>
          <UploadForm info={detail.uploadInfo} collectionId={collection.id} collectionName={collection.name} />
        </div>
      )}

      <form
        method="get"
        action={`/collections/${collection.id}`}
        className="collection-toolbar collection-video-filter"
        role="search"
      >
        <label className="collection-search-field">
          <span className="sr-only">Search videos</span>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <input
            type="search"
            name="q"
            defaultValue={detail.videoSearch ?? ""}
            maxLength={100}
            placeholder="Search videos..."
          />
        </label>

        <label className="collection-sort-field">
          <span className="sr-only">Sort videos</span>
          <select name="sort" defaultValue={detail.videoSort ?? "newest"} aria-label="Sort videos">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name</option>
            <option value="size">File size</option>
          </select>
        </label>

        <button type="submit" className="collection-filter-button">
          Apply
        </button>
      </form>

      {videos.length === 0 ? (
        <EmptyState
          title={
            detail.videoFiltered
              ? "No videos match your search"
              : "This collection is empty"
          }
          description={
            detail.videoFiltered
              ? "Try another search term or change your filters."
              : "Videos added to this collection will appear here."
          }
        />
      ) : (
        <div className="collection-video-grid">
          {videos.map((video) => {
            const job = detail.importJobs?.find(
              (entry) => entry.sourceMediaId === video.id,
            );

            return (
              <article
                className="collection-video-card"
                key={video.id}
                data-media-id={video.id}
              >
                <div className="collection-video-preview">
                  <CollectionVideoPreview media={video} />
                </div>
                <div className="collection-video-card-body">
                  <h3 className="collection-video-title">{video.title}</h3>
                  <div className="collection-video-meta">
                    <span>{formatDuration(video.durationMs)}</span>
                    <span>{formatStorage(video.sizeBytes)}</span>
                  </div>

                  {permissions.canManage && (
                    <CollectionVideoRemoveAction
                      collectionId={collection.id}
                      collectionName={collection.name}
                      mediaAssetId={video.id}
                      mediaTitle={video.title}
                    />
                  )}

                  {permissions.canRequestImport && (
                    <div className="collection-video-import">
                      {job ? (
                        <div className="collection-import-status">
                          <span className={`collection-status collection-status-${job.status}`}>
                            {job.status.replaceAll("_", " ")}
                          </span>

                          {job.failureReason && (
                            <p className="collection-form-hint">{job.failureReason}</p>
                          )}

                          {job.status === "succeeded" && (
                            <a href={`/media/${job.resultMediaAssetId}`}>
                              Open imported copy
                            </a>
                          )}

                          {job.status === "failed" && (
                            <form method="post" action="/api/forms/media-import-retry">
                              <input type="hidden" name="jobId" value={job.id} />
                              <input type="hidden" name="collectionId" value={collection.id} />
                              <button type="submit" className="collection-secondary-button">
                                Retry import
                              </button>
                            </form>
                          )}

                          <p className="collection-form-hint">
                            Updated {job.updatedAt.toISOString()}
                          </p>
                        </div>
                      ) : (
                        <form
                          method="post"
                          action="/api/forms/media-import"
                          className="collection-import-form"
                        >
                          <input type="hidden" name="sourceMediaId" value={video.id} />
                          <input type="hidden" name="sourceCollectionId" value={collection.id} />

                          <label className="collection-confirm-checkbox">
                            <input
                              type="checkbox"
                              name="warningAcknowledged"
                              value="yes"
                              required
                            />
                            <span>
                              I understand this creates a separate copy and uses my storage allowance.
                            </span>
                          </label>

                          <button type="submit" className="collection-secondary-button">
                            Import to my library
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {permissions.canRequestImport && (
        <p className="collection-form-hint">
          The original remains with its owner. A queued import is not a completed copy; the status changes when processing and verification finish.
        </p>
      )}
    </section>
  );
}

export function CollectionDetailView({ detail }: { detail: CollectionDetail }) {
  const { collection, permissions } = detail;

  return (
    <main className="collection-detail-page">
      <a href="/collections" className="collection-back-link">
        <span aria-hidden="true">←</span> All collections
      </a>

      <header className="collection-detail-header">
        <div className="collection-detail-title-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
        </div>

        <div className="collection-detail-heading-content">
          <span className="collection-eyebrow">COLLECTION</span>
          <h1>{collection.name}</h1>
          {collection.description && <p>{collection.description}</p>}

          <div className="collection-detail-badges">
            <span className={`collection-visibility collection-visibility-${collection.visibility}`}>
              {VISIBILITY_LABELS[collection.visibility]}
            </span>
            <span className="collection-owner-label">
              {collection.sharedByAnotherUser ? "Shared with you" : "Your collection"}
            </span>
            {collection.archived && (
              <span className="collection-archived-label">Archived</span>
            )}
          </div>
        </div>
        <nav className="collection-detail-actions" aria-label="Collection actions">
          <a href="#collection-videos" className="collection-secondary-button">Videos</a>
          {permissions.canUseInCycle && <a href="#add-to-cycle" className="collection-secondary-button">Add to cycle</a>}
          {permissions.isOwner && detail.memberIds.length > 0 && <a href={`/editor/bulk?${detail.memberIds.map((id) => `media=${encodeURIComponent(id)}`).join("&")}`} className="collection-primary-button">Apply template to all videos</a>}
          {permissions.isOwner && <a href="#collection-settings" className="collection-secondary-button">Edit details</a>}
          {permissions.isOwner && detail.sharingManagement && <a href="#sharing-management" className="collection-secondary-button">Manage sharing</a>}
        </nav>
      </header>

      <PermissionOverview detail={detail} />

      <CollectionVideos detail={detail} />

      <MixForm detail={detail} />

      {permissions.isOwner && (
        <div className="collection-owner-sections">
          <div className="collection-owner-heading">
            <span className="collection-eyebrow">OWNER WORKSPACE</span>
            <h2>Manage collection</h2>
            <p>Control access, sharing, files and collection settings.</p>
          </div>

          <SharingManagement detail={detail} />
          <ShareLinks detail={detail} />
          <PendingAccessRequests detail={detail} />
          <CollectionCaptionCoverEditor detail={detail} />
          <CollectionSettings detail={detail} />
        </div>
      )}
    </main>
  );
}
