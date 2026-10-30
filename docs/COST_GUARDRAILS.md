# Cost guardrails (AWS spend must stay at zero until the owner approves otherwise)

**Rules for every session**
1. No AWS resources are created, no AWS CLI/SDK commands are run, no AWS Agent Toolkit is installed, no deployment is performed.
   If any of that ever becomes useful, FIRST explain exactly what it will change and what it could cost, then wait for explicit approval.
2. The AWS Free Plan is preserved: never upgrade the account, never join an AWS Organization, never create billable resources
   (S3 buckets, EC2/ECS, RDS, CloudFront, NAT gateways, etc.) without explicit approval.
3. Development uses local adapters only: in-memory repository (demo mode) now; local PostgreSQL and a local-disk media adapter
   later. Storage, database, queue and publishing sit behind interfaces (`Repository`, future `MediaStorage`, `JobQueue`) so the real
   services can be plugged in later without rewriting screens or rules.
4. Private media is never exposed: view models contain no storage keys or URLs; originals are not downloadable unless the owner
   granted `download`; when S3 exists it stays private with short-lived presigned URLs.

**Storage specifically:** uploads use server memory or a private local folder (`CLIPFORGE_LOCAL_MEDIA_DIR`, gitignored `.local-media/`). No S3 adapter exists; when one is written it must stay private (presigned, short-lived URLs), and creating the bucket needs your explicit approval first.

**Current state:** no AWS credentials exist in the repo or the sandbox; `.env.example` holds placeholders only; nothing here calls
any cloud service.
