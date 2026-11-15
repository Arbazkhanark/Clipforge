# Cost guardrails (AWS spend must stay at zero until the owner approves otherwise)

**Rules for every session**
1. No AWS resources are created, no AWS CLI/SDK commands are run, no AWS Agent Toolkit is installed, no deployment is performed.
   If any of that ever becomes useful, FIRST explain exactly what it will change and what it could cost, then wait for explicit approval.
2. The AWS Free Plan is preserved: never upgrade the account, never join an AWS Organization, never create billable resources
   (S3 buckets, EC2/ECS, RDS, CloudFront, NAT gateways, etc.) without explicit approval.
3. Development and production media storage use separate private S3 buckets and IAM identities. Demo/test memory and explicitly
   selected local-disk fallback stay available for local testing. S3 storage remains behind `MediaStorage` and creates no AWS
   resources by itself.
4. Private media is never exposed: view models contain no storage keys or URLs; originals are not downloadable unless the owner
   granted `download`; S3 objects stay private and app requests stream authorized content through the existing routes.

**Storage specifically:** the application adapter uses private S3 objects and never returns object URLs. This repository change creates no buckets, IAM identities, or cloud resources. Those require separate approval. Uploads, rendering, imports, and publishing workers use server-side S3 access. The existing HMAC-signed application route remains the temporary Instagram media access mechanism.

**Current state:** the repository contains S3 client code and configuration names; no AWS resources or live cloud connection have
been created or tested from this work.
