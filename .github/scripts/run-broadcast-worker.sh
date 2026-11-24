#!/usr/bin/env bash
set -euo pipefail

: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?GitHub OIDC token request token is missing}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?GitHub OIDC token request URL is missing}"

token="$({
  curl --fail --silent --show-error \
    --header "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=studypak-broadcast-worker"
} | jq --raw-output '.value')"

test -n "${token}" && test "${token}" != "null"

curl --fail-with-body --silent --show-error \
  --retry 2 \
  --max-time 110 \
  --header "Authorization: Bearer ${token}" \
  https://studypak.vercel.app/api/broadcasts/worker

