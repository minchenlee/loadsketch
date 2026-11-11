#!/bin/bash
# Make the Terraform plan JSON fixtures in tests/import/fixtures/.
#
#   scripts/gen-fixtures.sh --init   # once, with network: download the AWS provider (HashiCorp registry)
#   scripts/gen-fixtures.sh          # offline: plan every fixture inside the sandbox
#
# Never `terraform apply`. Every `terraform plan` and `terraform show` runs inside a macOS sandbox
# that blocks all outbound network except localhost; the script proves the sandbox blocks before the
# first plan. The fake credentials and the 127.0.0.1:1 endpoints in each main.tf are only a second
# line: a plan that succeeds does not by itself prove that it did not call AWS.
set -euo pipefail
cd "$(dirname "$0")/.."
FIXTURES=tests/import/fixtures
SETS=(ecs-rds lambda-sqs-rds aurora-cache-multiaz)

# Outbound network is denied except localhost and Unix sockets in the per-user temp folder:
# Terraform talks to its provider plugins over a Unix socket there (go-plugin), so that one stays open.
SANDBOX='(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket (path-regex #"^(/private)?/var/folders/")))'
sandboxed() { sandbox-exec -p "$SANDBOX" "$@"; }
export TF_IN_AUTOMATION=1 CHECKPOINT_DISABLE=1
TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"
export TMPDIR

if [ "${1:-}" = "--init" ]; then
  for s in "${SETS[@]}"; do terraform -chdir="$FIXTURES/$s" init -input=false -backend=false; done
  exit 0
fi

# Proof first: the sandbox starts (a failure to start must not count as "blocked"), and inside it
# a request to the internet fails.
if [ "$(sandboxed /bin/echo ok)" != ok ]; then
  echo "gen-fixtures: sandbox-exec could not start; stopping" >&2
  exit 1
fi
if sandboxed curl -s -m 5 -o /dev/null https://example.com; then
  echo "gen-fixtures: the sandbox did not block https://example.com; stopping" >&2
  exit 1
fi

for s in "${SETS[@]}"; do
  dir="$FIXTURES/$s"
  [ -d "$dir/.terraform" ] || { echo "gen-fixtures: run 'scripts/gen-fixtures.sh --init' first ($dir)" >&2; exit 1; }
  sandboxed terraform -chdir="$dir" plan -input=false -lock=false -refresh=false -out=plan.bin >/dev/null
  sandboxed terraform -chdir="$dir" show -json plan.bin > "$dir/plan.raw.json"
  rm -f "$dir/plan.bin"
  node scripts/scrub-plan.ts "$dir/plan.raw.json" "$dir/main.tf" > "$FIXTURES/$s.plan.json"
  rm -f "$dir/plan.raw.json"
  echo "gen-fixtures: wrote $FIXTURES/$s.plan.json"
done
