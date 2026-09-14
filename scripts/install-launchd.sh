#!/bin/sh
set -eu

REPO_DIR="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
REPO_DIR="$(CDPATH= cd -- "$REPO_DIR" && pwd)"
NODE_BIN="${WEBOT_NODE_BIN:-/opt/homebrew/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="/usr/local/bin/node"
fi
if [ ! -x "$NODE_BIN" ]; then
  printf 'Webot requires Node.js 22 or newer\n' >&2
  exit 1
fi

APP_DIR="${WEBOT_DATA_DIR:-$HOME/Library/Application Support/Webot}"
SETTINGS_FILE="${WEBOT_SETTINGS_FILE:-$APP_DIR/settings.json}"
LOG_DIR="${WEBOT_LOG_DIR:-$HOME/Library/Logs/Webot}"
WORKSPACE_DIR="$APP_DIR/workspace"
LAUNCHER_DIR="$APP_DIR/bin"
LAUNCHER="$LAUNCHER_DIR/webot-source-launcher.sh"
REVISION_FILE="${WEBOT_SOURCE_REVISION_FILE:-$APP_DIR/source-revision}"
LABEL="${WEBOT_SERVICE_LABEL:-com.webot.agent}"
PLIST="${WEBOT_SERVICE_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
SERVICE="gui/$(id -u)/$LABEL"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$APP_DIR/backups/$STAMP-source-install"
CANDIDATE_PLIST="$HOME/Library/LaunchAgents/.$LABEL.candidate.$$.plist"
CANDIDATE_LAUNCHER="$LAUNCHER_DIR/.webot-source-launcher.candidate.$$"
CANDIDATE_REVISION="$APP_DIR/.source-revision.candidate.$$"
REVISION="$(git -C "$REPO_DIR" rev-parse HEAD)"
ACTIVATION_STARTED=0
HAD_PLIST=0
HAD_LAUNCHER=0
HAD_REVISION=0

mkdir -p \
  "$APP_DIR" \
  "$LOG_DIR" \
  "$WORKSPACE_DIR" \
  "$LAUNCHER_DIR" \
  "$HOME/Library/LaunchAgents" \
  "$BACKUP_DIR"
chmod 700 \
  "$APP_DIR" \
  "$LOG_DIR" \
  "$WORKSPACE_DIR" \
  "$LAUNCHER_DIR" \
  "$BACKUP_DIR"

if [ ! -f "$SETTINGS_FILE" ]; then
  cp "$REPO_DIR/packaging/settings.example.json" "$SETTINGS_FILE"
fi
chmod 600 "$SETTINGS_FILE"
cp "$REPO_DIR/scripts/run-source.sh" "$CANDIDATE_LAUNCHER"
chmod 700 "$CANDIDATE_LAUNCHER"
printf '%s\n' "$REVISION" >"$CANDIDATE_REVISION"
chmod 600 "$CANDIDATE_REVISION"

cat >"$CANDIDATE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$LAUNCHER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>WEBOT_REPO_DIR</key>
    <string>$REPO_DIR</string>
    <key>WEBOT_NODE_BIN</key>
    <string>$NODE_BIN</string>
    <key>WEBOT_DATA_DIR</key>
    <string>$APP_DIR</string>
    <key>WEBOT_SETTINGS_FILE</key>
    <string>$SETTINGS_FILE</string>
    <key>WEBOT_SOURCE_REVISION_FILE</key>
    <string>$REVISION_FILE</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/stderr.log</string>
</dict>
</plist>
EOF
plutil -lint "$CANDIDATE_PLIST"

if [ -f "$PLIST" ]; then
  cp "$PLIST" "$BACKUP_DIR/$(basename "$PLIST")"
  chmod 600 "$BACKUP_DIR/$(basename "$PLIST")"
  HAD_PLIST=1
fi
if [ -f "$LAUNCHER" ]; then
  cp "$LAUNCHER" "$BACKUP_DIR/webot-source-launcher.sh"
  chmod 700 "$BACKUP_DIR/webot-source-launcher.sh"
  HAD_LAUNCHER=1
fi
if [ -f "$REVISION_FILE" ]; then
  cp "$REVISION_FILE" "$BACKUP_DIR/source-revision"
  chmod 600 "$BACKUP_DIR/source-revision"
  HAD_REVISION=1
fi

restore_previous() {
  /bin/launchctl bootout "$SERVICE" 2>/dev/null || true
  if [ "$HAD_PLIST" -eq 1 ]; then
    cp "$BACKUP_DIR/$(basename "$PLIST")" "$PLIST"
    chmod 600 "$PLIST"
  else
    rm -f "$PLIST"
  fi
  if [ "$HAD_LAUNCHER" -eq 1 ]; then
    cp "$BACKUP_DIR/webot-source-launcher.sh" "$LAUNCHER"
    chmod 700 "$LAUNCHER"
  else
    rm -f "$LAUNCHER"
  fi
  if [ "$HAD_REVISION" -eq 1 ]; then
    cp "$BACKUP_DIR/source-revision" "$REVISION_FILE"
    chmod 600 "$REVISION_FILE"
  else
    rm -f "$REVISION_FILE"
  fi
  if [ "$HAD_PLIST" -eq 1 ]; then
    /bin/launchctl bootstrap "gui/$(id -u)" "$PLIST"
    /bin/launchctl kickstart -k "$SERVICE"
  fi
}

cleanup() {
  rm -f "$CANDIDATE_PLIST" "$CANDIDATE_LAUNCHER" "$CANDIDATE_REVISION"
}

on_exit() {
  STATUS=$?
  trap - EXIT HUP INT TERM
  if [ "$STATUS" -ne 0 ] && [ "$ACTIVATION_STARTED" -eq 1 ]; then
    printf 'Webot source activation failed; restoring %s\n' "$BACKUP_DIR" >&2
    restore_previous || true
  fi
  cleanup
  exit "$STATUS"
}

trap on_exit EXIT
trap 'exit 1' HUP INT TERM

if /usr/bin/curl -sS --max-time 2 http://127.0.0.1:18120/health >/dev/null 2>&1; then
  /usr/bin/curl -fsS --max-time 5 \
    -X POST http://127.0.0.1:18120/api/admin/workers/drain \
    >/dev/null
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 120 ]; do
    if "$NODE_BIN" --input-type=module -e '
      const response = await fetch("http://127.0.0.1:18120/health");
      const health = await response.json();
      process.exit(Number(health.workers?.active || 0) === 0 ? 0 : 1);
    ' >/dev/null 2>&1; then
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
  if [ "$ATTEMPT" -ge 120 ]; then
    printf 'Webot workers did not drain within 120 seconds\n' >&2
    exit 1
  fi
fi

ACTIVATION_STARTED=1
/bin/launchctl bootout "$SERVICE" 2>/dev/null || true
mv "$CANDIDATE_PLIST" "$PLIST"
mv "$CANDIDATE_LAUNCHER" "$LAUNCHER"
mv "$CANDIDATE_REVISION" "$REVISION_FILE"
chmod 700 "$LAUNCHER"
chmod 600 "$PLIST" "$REVISION_FILE"

if ! /bin/launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  sleep 1
  /bin/launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi
/bin/launchctl kickstart -k "$SERVICE"

ATTEMPT=0
while [ "$ATTEMPT" -lt 60 ]; do
  if WEBOT_EXPECTED_REVISION="$REVISION" "$NODE_BIN" --input-type=module -e '
    const response = await fetch("http://127.0.0.1:18120/health");
    const health = await response.json();
    const ready = response.ok &&
      health.ok === true &&
      health.runtime?.mode === "source" &&
      health.runtime?.sourceRevision === process.env.WEBOT_EXPECTED_REVISION;
    process.exit(ready ? 0 : 1);
  ' >/dev/null 2>&1; then
    ACTIVATION_STARTED=0
    printf 'Webot source service installed: %s (%s)\n' "$REVISION" "$LABEL"
    exit 0
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

printf 'Webot did not become healthy in source mode; check %s/stderr.log\n' "$LOG_DIR" >&2
exit 1
