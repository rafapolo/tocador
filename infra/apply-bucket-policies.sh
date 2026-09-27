#!/bin/sh
# Re-applies the private bucket policies (owner-only reads; see CLAUDE.md → "S3 bucket policy").
# Verify afterwards with repeated anonymous curls — one Ceph gateway node can lag ~2 min.
set -e
cd "$(dirname "$0")/.."
export $(grep -E '^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=' .env | tr -d '"' | xargs)
for b in sambaraiz indie; do
  aws --endpoint-url https://hel1.your-objectstorage.com --region hel1 \
    s3api put-bucket-policy --bucket "$b" --policy "file://infra/bucket-policy-$b.json"
  echo "applied: $b"
done
