#!/usr/bin/env bash
# Runs one scheduled relay job and tells the operators' Sentry project about it (a cron monitor check-in). Installed as
# /usr/local/sbin/relay-checkin by setup-host.sh; the timers' services run their job through it:
#
#   relay-checkin <monitor slug> <schedule> <margin min> <max runtime min> -- <job> [args…]
#     schedule: a crontab line in UTC ("40 18 * * *") or "every <n> <minute|hour|day>"
#
# With RELAY_SENTRY_DSN (the environment, else /etc/mycel-relay/relay.env) it sends `in_progress` (with the monitor's
# schedule, so Sentry creates the monitor on its first run), runs the job, then `ok` or `error`. Without it, it only runs
# the job. The job's output and exit code are kept as they are: a check-in that cannot be sent (no network, Sentry down,
# a bad key) is a line on stderr and never changes the job's result. Only the slug, a random check-in id, the status,
# the environment and the schedule are sent: never the job's output.
# The URL is Sentry's HTTP check-in endpoint (docs.sentry.io "Crons > HTTP"); shared/src/sentry-report.ts checkInUrl is
# its TypeScript twin (tests/unit/relay-checkin.test.ts checks both build the same URL).
set -uo pipefail

usage() { echo "usage: relay-checkin <slug> <schedule> <margin min> <max runtime min> -- <job> [args...]" >&2; exit 64; }
[ $# -ge 6 ] && [ "$5" = "--" ] || usage
slug=$1 schedule=$2 margin=$3 max_runtime=$4
shift 5
[[ $slug =~ ^[a-z0-9][a-z0-9-]{0,49}$ ]] || usage
[[ $margin =~ ^[0-9]{1,4}$ && $max_runtime =~ ^[0-9]{1,4}$ ]] || usage

# one setting from relay.env, read as text (the file is not sourced here)
setting() {
  local name=$1 file=${RELAY_ENV_FILE:-/etc/mycel-relay/relay.env}
  [ -r "$file" ] || return 0
  sed -n "s/^${name}=//p" "$file" | tail -n 1 | tr -d "\"'\r"
}
dsn=${RELAY_SENTRY_DSN-$(setting RELAY_SENTRY_DSN)}
env_name=${RELAY_SENTRY_ENV-$(setting RELAY_SENTRY_ENV)}
# a DSN holds no spaces: drop any around it (a trailing space or tab in relay.env), as parseDsn trims
dsn=$(printf '%s' "$dsn" | tr -d '[:space:]')
env_name=$(printf '%s' "$env_name" | tr -d '[:space:]')
[[ $env_name =~ ^[a-z0-9._-]{1,32}$ ]] || env_name=production

url=""
if [ -n "$dsn" ]; then
  # https://<public key>@<host>[/<prefix>]/<project id>  ->  https://<host>[/<prefix>]/api/<project id>/cron/<slug>/<key>/
  if [[ $dsn =~ ^https://([A-Za-z0-9]+)@([A-Za-z0-9.:-]+)(/[A-Za-z0-9._/-]*)?/([0-9]+)$ ]]; then
    url="https://${BASH_REMATCH[2]}${BASH_REMATCH[3]}/api/${BASH_REMATCH[4]}/cron/${slug}/${BASH_REMATCH[1]}/"
  else
    echo "relay-checkin: RELAY_SENTRY_DSN is not a Sentry key; no check-in sent" >&2
  fi
fi

case $schedule in
  "every "*)
    read -r _ n unit <<<"$schedule"
    [[ $n =~ ^[0-9]{1,4}$ && $unit =~ ^(minute|hour|day)$ ]] || usage
    schedule_json="{\"type\":\"interval\",\"value\":$n,\"unit\":\"$unit\"}" ;;
  *)
    [[ $schedule =~ ^[0-9A-Za-z*/,\ -]{9,60}$ ]] || usage
    schedule_json="{\"type\":\"crontab\",\"value\":\"$schedule\"}" ;;
esac

new_id() {
  if [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null; then uuidgen | tr '[:upper:]' '[:lower:]'
  else od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/'
  fi
}

# send <url> [curl options]: never fails, a check-in is a side note to the job. The URL holds the project's key, so it
# goes to curl as a config line on stdin (-K -), not as an argument other users could read in ps.
send() {
  [ -n "$url" ] || return 0
  local to=$1
  shift
  printf 'url = "%s"\n' "$to" | curl -fsS --max-time 10 -o /dev/null -K - "$@" || echo "relay-checkin: the $slug check-in was not sent" >&2
  return 0
}

id=$(new_id)
send "$url" -X POST -H 'content-type: application/json' --data-binary \
  "{\"check_in_id\":\"$id\",\"status\":\"in_progress\",\"environment\":\"$env_name\",\"monitor_config\":{\"schedule\":$schedule_json,\"checkin_margin\":$margin,\"max_runtime\":$max_runtime,\"timezone\":\"UTC\"}}"

"$@"
rc=$?

if [ "$rc" = 0 ]; then status=ok; else status=error; fi
send "${url}?check_in_id=${id}&status=${status}&environment=${env_name}"
exit "$rc"
