#!/usr/bin/env bash
# The live handover's synthetic branch is removed only after its committed result is verified.
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${BRANCH:?}" "${BASE:?}" "${EXPECTED_FILE:?}" "${EXPECTED_LINE:?}"
[[ "$BRANCH" =~ ^fuse/[A-Za-z0-9_-]+$ ]] || { echo '::error::Unexpected live-check branch'; exit 1; }
[[ "$EXPECTED_FILE" =~ ^live-check/[A-Za-z0-9_-]+\.md$ ]] || { echo '::error::Unexpected live-check filename'; exit 1; }
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

gh api "repos/${GITHUB_REPOSITORY}/compare/${BASE}...${BRANCH}" > "$work_dir/compare.json"
gh api "repos/${GITHUB_REPOSITORY}/commits/${BRANCH}" > "$work_dir/commit.json"
jq -e --arg file "$EXPECTED_FILE" '(.ahead_by > 0) and (.files | length == 1) and (.files[0].filename == $file) and (.files[0].status == "added")' "$work_dir/compare.json" >/dev/null || {
  echo '::error::Expected exactly the one newly committed live-check file; branch retained'
  exit 1
}
jq -e '.commit.author.name == "FUSE Benchmark"' "$work_dir/commit.json" >/dev/null || {
  echo '::error::Expected the handover git author; branch retained'
  exit 1
}
gh api "repos/${GITHUB_REPOSITORY}/contents/${EXPECTED_FILE}?ref=${BRANCH}" --jq .content | base64 --decode > "$work_dir/actual"
printf '%s\n' "$EXPECTED_LINE" > "$work_dir/expected"
cmp -s "$work_dir/actual" "$work_dir/expected" || {
  echo '::error::Unexpected committed live-check content; branch retained'
  exit 1
}
commit=$(jq -r .sha "$work_dir/commit.json")
echo "Verified $EXPECTED_FILE at $commit, authored by FUSE Benchmark."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Live check passed\n\nFile: `%s`\n\nCommit: `%s`\n\nBase: `%s`\n' "$EXPECTED_FILE" "$commit" "$BASE" >> "$GITHUB_STEP_SUMMARY"
fi
if [[ -n "${EVIDENCE_FILE:-}" ]]; then
  jq -n --arg commit "$commit" --arg base "$BASE" --arg file "$EXPECTED_FILE" \
    --arg server "${HULK_BUILD:?}" --arg schema "${HULK_SCHEMA:?}" \
    --arg device "${TEST_DEVICE_ID:?}" --arg name "${TEST_DEVICE_NAME:?}" \
    --arg request "${REQUEST_ID:?}" --arg branch "$BRANCH" \
    '{passed:true,commit:$commit,base:$base,file:$file,server:{builtFrom:$server,schema:($schema|tonumber)},device:{id:$device,name:$name},request:$request,branch:$branch,branchDeleted:true}' > "$work_dir/evidence.json"
fi
gh api -X DELETE "repos/${GITHUB_REPOSITORY}/git/refs/heads/${BRANCH}"
echo "Deleted verified temporary branch $BRANCH."
if [[ -n "${EVIDENCE_FILE:-}" ]]; then mv "$work_dir/evidence.json" "$EVIDENCE_FILE"; fi
