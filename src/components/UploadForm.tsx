import type { UploadInfo } from "../server/queries.ts";

const ACCEPT = ".mp4,.mov,.webm,.jpg,.jpeg,.png,.webp,video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp";

/** A plain form (no JavaScript needed). The page states clearly WHERE the file would go: demo memory, local disk, or (future) cloud. */
export function UploadForm({ info }: { info: UploadInfo }) {
  return (
    <section aria-labelledby="upload-heading" className="card">
      <h2 id="upload-heading">Upload</h2>
      <p>Storage: <strong>{info.storage.label}</strong></p>
      <p role="note" className="notice" data-storage-kind={info.storageKind ?? "none"}>{info.storage.warning}</p>
      {info.available ? (
        <form method="post" action="/api/forms/media-upload" encType="multipart/form-data">
          <p><label>Choose a video or image<br /><input type="file" name="file" accept={ACCEPT} required /></label></p>
          <p className="muted">MP4, MOV or WebM video; JPEG, PNG or WebP images; up to {info.maxMegabytes} MB per file. The file's contents are checked - its name and declared type are not trusted.</p>
          <button type="submit">Upload</button>
        </form>
      ) : <p>Uploads are not available in this build until storage is configured.</p>}
      <p className="muted">Cloud (S3) storage is not connected.</p>
    </section>
  );
}
