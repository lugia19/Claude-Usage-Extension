#!/usr/bin/env bash
# codex-react.sh <pr-number> <PRRC_node_id> <up|down|none> [owner/repo]
# Reacts to a Codex review comment and resolves its thread.
# 'none' skips the reaction but still resolves the thread.
# Usage:
#   bash scripts/codex-react.sh 12 PRRC_kwDOPbr1xM7FAVyc up
#   bash scripts/codex-react.sh 12 PRRC_kwDOPbr1xM7FAVyc down
#   bash scripts/codex-react.sh 12 PRRC_kwDOPbr1xM7FAVyc none

set -euo pipefail

PR="${1:?Usage: $0 <pr-number> <PRRC_node_id> <up|down|none> [owner/repo]}"
COMMENT_ID="${2:?Usage: $0 <pr-number> <PRRC_node_id> <up|down|none> [owner/repo]}"
DIRECTION="${3:?Usage: $0 <pr-number> <PRRC_node_id> <up|down|none> [owner/repo]}"
REPO="${4:-}"

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

# React on the comment node
case "$DIRECTION" in
  up)   CONTENT="THUMBS_UP" ;;
  down) CONTENT="THUMBS_DOWN" ;;
  none) ;;
  *)    echo "Unknown direction '$DIRECTION' — use 'up', 'down', or 'none'"; exit 1 ;;
esac

if [[ "$DIRECTION" != "none" ]]; then
  gh api graphql -f query="mutation { addReaction(input: { subjectId: \"$COMMENT_ID\", content: $CONTENT }) { reaction { content } } }" > /dev/null
  echo "Reacted $CONTENT on $COMMENT_ID"
fi

# Look up the thread that contains this comment and resolve it
THREAD_ID=$(gh api graphql -f query="{
  repository(owner:\"$OWNER\", name:\"$NAME\") {
    pullRequest(number: $PR) {
      reviewThreads(first: 100) {
        nodes { id comments(first: 1) { nodes { id } } }
      }
    }
  }
}" --jq ".data.repository.pullRequest.reviewThreads.nodes[] | select(.comments.nodes[].id == \"$COMMENT_ID\") | .id" | head -1)

if [[ -z "$THREAD_ID" ]]; then
  echo "Could not find thread for comment $COMMENT_ID"
  exit 1
fi

gh api graphql -f query="mutation { resolveReviewThread(input: { threadId: \"$THREAD_ID\" }) { thread { isResolved } } }" > /dev/null
echo "Resolved thread $THREAD_ID"
