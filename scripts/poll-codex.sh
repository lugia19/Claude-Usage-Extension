#!/usr/bin/env bash
# Poll a PR's Codex review state, optionally triggering the review first.
#
# Usage:
#   scripts/poll-codex.sh <pr-number> [--trigger|--read] [--message=...] [owner/repo]
#
# --trigger  Post @codex review, retry if no eyes ack within ACK_TIMEOUT. Then poll.
# --read     Snapshot current state (approved? comments?) and exit immediately.
# (no flag)  Watch for eyes ack; exit after NO_TRIGGER_MAX_POLLS cycles if none seen.
#
# Exits 0:
#   EVENT=thumbs_up                  Codex approved the PR
#   EVENT=new_comment current=<n>    Codex posted new inline comment(s)

set -euo pipefail

PR=""
TRIGGER="false"
READ="false"
REPO=""
MESSAGE=""

# Tunables
ACK_TIMEOUT="${ACK_TIMEOUT:-30}"        # seconds to wait for 👀 before re-requesting
ACK_MAX_RETRIES="${ACK_MAX_RETRIES:-2}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
NO_TRIGGER_MAX_POLLS="${NO_TRIGGER_MAX_POLLS:-2}"  # exit after N polls when not triggered
BOT_LOGIN="chatgpt-codex-connector[bot]"

for arg in "$@"; do
  case "$arg" in
    --trigger) TRIGGER="true" ;;
    --read)    READ="true" ;;
    --message=*) MESSAGE="${arg#--message=}" ;;
    *)
      if [ -z "$PR" ]; then
        PR="$arg"
      else
        REPO="$arg"
      fi
      ;;
  esac
done

if [ -z "$PR" ]; then
  echo "usage: poll-codex.sh <pr-number> [--trigger|--read] [owner/repo]" >&2
  exit 2
fi

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi

# Every GitHub list endpoint below pages at 30, and without --paginate `gh` fetches exactly one page.
# So on a PR past 30 Codex comments the count saturates at 30 and stops moving - and the poll loop
# compares that against a baseline of 30 and concludes "no new comments" forever. It fails in the
# reassuring direction: a pass that found seven problems reads identically to a clean one. PR #1140
# hit this at 57 comments, where the script's view of the PR was frozen two days in the past and
# reported an open review as absent.
#
# The jq filters need no rewrite to go with the flag: `gh --paginate` concatenates the pages into one
# array before applying --jq, so `length` counts the whole run and `.[$from:]` offsets into it.
# Measured on gh 2.96 and 2.97 alike - `--jq length` returns a single 57 against #1140's two pages,
# and `--jq '.[0].id'` returns a single line.
#
# The help text does say "Each page is a separate JSON array or object. Pass --slurp to wrap all
# pages", which reads like the opposite. That sentence is about raw output: `--slurp` is refused
# outright when --jq is given ("not supported with --jq or --template"), so if pages really were
# separate under --jq there would be no way to filter across them at all. Don't rewrite these into
# shell-side wc/tail on the strength of that sentence; it was checked.
comment_count() {
  gh api --paginate "repos/${REPO}/pulls/${PR}/comments" \
    --jq "[.[] | select(.user.login==\"${BOT_LOGIN}\")] | length"
}

dump_comments() {
  local from="${1:-0}"
  gh api --paginate "repos/${REPO}/pulls/${PR}/comments" \
    --jq "[.[] | select(.user.login==\"${BOT_LOGIN}\")] | .[$from:] | .[] | .node_id + \": \" + (.body | gsub(\"[\\n\\r]+\"; \" \"))" \
    | while IFS= read -r line; do
        node_id="${line%%: *}"
        body="${line#*: }"
        priority=$(echo "$body" | sed -n 's/.*badge\/P\([0-9]\).*/\1/p' | head -1)
        title=$(echo "$body" | sed -n 's/.*<\/sub>[[:space:]]*\([^*]*\)\*\*.*/\1/p' | head -1)
        rest=$(echo "$body" | sed 's/.*\*\* //' | sed 's/ Useful.*//')
        if [ -n "$priority" ] && [ -n "$title" ]; then
          echo "  [P${priority}] ${node_id}"
          echo "  ${title}"
          echo "  ${rest}"
        else
          echo "  ${node_id}: ${body}" | cut -c1-200
        fi
        echo ""
      done
}

# Paginated for the same reason, though it bites later here: the bot holds at most one reaction of
# each kind, but this filters them out of a list that includes everyone else's, so on a PR with 30+
# reactions the bot's 👍 can sit on page 2 and approval reads as "not approved yet".
reaction_ids() {
  gh api --paginate "repos/${REPO}/issues/${PR}/reactions" \
    --jq ".[] | select(.user.login==\"${BOT_LOGIN}\" and .content==\"$1\") | .id"
}

has_new_reaction() {
  local content="$1"
  local baseline="$2"
  local current
  current=$(reaction_ids "$content")
  if [ -z "$current" ]; then return 1; fi
  local current_sorted baseline_sorted
  current_sorted=$(printf '%s\n' "$current" | sort -u)
  baseline_sorted=$(printf '%s\n' "$baseline" | sort -u)
  comm -23 <(printf '%s\n' "$current_sorted") <(printf '%s\n' "$baseline_sorted") | grep -q .
}

post_review_comment() {
  local body="@codex review"
  if [ -n "$MESSAGE" ]; then body="@codex review ${MESSAGE}"; fi
  gh pr comment "$PR" --repo "$REPO" --body "$body" >/dev/null
}

# --- Baselines ---------------------------------------------------------------
BASELINE_COMMENTS=$(comment_count)
BASELINE_THUMBS=$(reaction_ids "+1" || true)
BASELINE_EYES=$(reaction_ids "eyes" || true)
echo "baseline_comments=${BASELINE_COMMENTS}"

# --read: snapshot and exit immediately
if [ "$READ" = "true" ]; then
  [ -n "$BASELINE_THUMBS" ] && echo "approved=yes" || echo "approved=no"
  [ -n "$BASELINE_EYES" ]   && echo "review_in_progress=yes" || echo "review_in_progress=no"
  if [ "$BASELINE_COMMENTS" -gt 0 ]; then
    echo "comments=${BASELINE_COMMENTS}:"
    dump_comments 0
  fi
  exit 0
fi

# Without --trigger: just watching. If already approved and no review in
# progress (no eyes), nothing to wait for — exit immediately.
if [ "$TRIGGER" = "false" ] && [ -n "$BASELINE_THUMBS" ] && [ -z "$BASELINE_EYES" ]; then
  echo "EVENT=thumbs_up (already approved, no review in progress)"
  exit 0
fi

# --- Trigger + ack phase -----------------------------------------------------
if [ "$TRIGGER" = "true" ]; then
  attempt=0
  acked="false"
  triggered="false"

  while [ "$attempt" -le "$ACK_MAX_RETRIES" ]; do
    if [ "$attempt" -eq 0 ]; then
      echo "trigger=initial"
    else
      echo "trigger=retry attempt=${attempt}"
    fi
    post_review_comment
    triggered="true"

    waited=0
    while [ "$waited" -lt "$ACK_TIMEOUT" ]; do
      if has_new_reaction "eyes" "${BASELINE_EYES}"; then
        acked="true"
        echo "ack=eyes after=${waited}s"
        break 2
      fi
      sleep 5
      waited=$((waited + 5))
    done
    attempt=$((attempt + 1))
  done

  if [ "$acked" != "true" ]; then
    echo "warn=no_ack_after_retries proceeding_anyway"
  fi
elif [ -n "$BASELINE_EYES" ]; then
  echo "ack=eyes already present, polling"
else
  echo "no_trigger=watching for up to $((NO_TRIGGER_MAX_POLLS * POLL_INTERVAL))s"
fi

# --- Poll for result ----------------------------------------------------------
poll_count=0
eyes_seen="${BASELINE_EYES}"  # non-empty if a review was already in progress
while true; do
  if has_new_reaction "+1" "${BASELINE_THUMBS}"; then
    echo "EVENT=thumbs_up"
    exit 0
  fi
  CURRENT=$(comment_count)
  if [ "$CURRENT" -gt "$BASELINE_COMMENTS" ]; then
    echo "EVENT=new_comment current=${CURRENT}"
    dump_comments "$BASELINE_COMMENTS" || true
    exit 0
  fi
  sleep "$POLL_INTERVAL"
  # If eyes appear during polling, a review started — disable the no-trigger limit.
  # Checked after sleep so eyes that arrive during the sleep window aren't missed.
  if [ -z "$eyes_seen" ] && has_new_reaction "eyes" "${BASELINE_EYES}"; then
    echo "ack=eyes appeared during polling, continuing indefinitely"
    eyes_seen="true"
  fi
  poll_count=$((poll_count + 1))
  if [ "$TRIGGER" = "false" ] && [ -z "$eyes_seen" ] && [ "$poll_count" -ge "$NO_TRIGGER_MAX_POLLS" ]; then
    if [ "$BASELINE_COMMENTS" -gt 0 ]; then
      echo "EVENT=existing_comments baseline=${BASELINE_COMMENTS}"
      dump_comments 0 || true
    else
      echo "EVENT=no_review_in_progress (exiting after ${poll_count} polls)"
    fi
    exit 0
  fi
done
