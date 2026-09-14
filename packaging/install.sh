#!/bin/sh
set -eu

PACKAGE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/Webot"
BIN_DIR="$APP_DIR/bin"
LOG_DIR="$HOME/Library/Logs/Webot"
WORKSPACE_DIR="$APP_DIR/workspace"
PLIST="$HOME/Library/LaunchAgents/com.webot.agent.plist"
UID_VALUE="$(id -u)"
SERVICE="gui/$UID_VALUE/com.webot.agent"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$APP_DIR/backups/$STAMP-install"
CANDIDATE_BIN="$BIN_DIR/.webot.candidate.$$"
CANDIDATE_PLIST="$HOME/Library/LaunchAgents/.com.webot.agent.candidate.$$.plist"
ACTIVATION_STARTED=0
HAD_BIN=0
HAD_PLIST=0

mkdir -p "$BIN_DIR" "$LOG_DIR" "$WORKSPACE_DIR" "$HOME/Library/LaunchAgents" "$BACKUP_DIR"
chmod 700 "$APP_DIR" "$BIN_DIR" "$LOG_DIR" "$WORKSPACE_DIR"
cp "$PACKAGE_DIR/webot" "$CANDIDATE_BIN"
chmod 700 "$CANDIDATE_BIN"

if [ ! -f "$APP_DIR/settings.json" ]; then
  cp "$PACKAGE_DIR/settings.example.json" "$APP_DIR/settings.json"
fi
chmod 600 "$APP_DIR/settings.json"
if [ ! -f "$WORKSPACE_DIR/AGENTS.md" ]; then
  cp "$PACKAGE_DIR/AGENTS.example.md" "$WORKSPACE_DIR/AGENTS.md"
fi
chmod 600 "$WORKSPACE_DIR/AGENTS.md"

cat >"$CANDIDATE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.webot.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_DIR/webot</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WEBOT_DATA_DIR</key>
    <string>$APP_DIR</string>
    <key>WEBOT_SETTINGS_FILE</key>
    <string>$APP_DIR/settings.json</string>
    <key>OPENAI_API_KEY</key>
    <string></string>
    <key>ANTHROPIC_API_KEY</key>
    <string></string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/stderr.log</string>
</dict>
</plist>
EOF

plutil -lint "$CANDIDATE_PLIST"

if [ -f "$BIN_DIR/webot" ]; then
  cp "$BIN_DIR/webot" "$BACKUP_DIR/webot"
  chmod 700 "$BACKUP_DIR/webot"
  HAD_BIN=1
fi
if [ -f "$PLIST" ]; then
  cp "$PLIST" "$BACKUP_DIR/com.webot.agent.plist"
  chmod 600 "$BACKUP_DIR/com.webot.agent.plist"
  HAD_PLIST=1
fi

restore_previous() {
  /bin/launchctl bootout "$SERVICE" 2>/dev/null || true
  if [ "$HAD_BIN" -eq 1 ]; then
    cp "$BACKUP_DIR/webot" "$BIN_DIR/webot"
    chmod 700 "$BIN_DIR/webot"
  else
    rm -f "$BIN_DIR/webot"
  fi
  if [ "$HAD_PLIST" -eq 1 ]; then
    cp "$BACKUP_DIR/com.webot.agent.plist" "$PLIST"
    chmod 600 "$PLIST"
  else
    rm -f "$PLIST"
  fi
  if [ "$HAD_BIN" -eq 1 ] && [ "$HAD_PLIST" -eq 1 ]; then
    /bin/launchctl bootstrap "gui/$UID_VALUE" "$PLIST"
    /bin/launchctl kickstart -k "$SERVICE"
  fi
}

cleanup() {
  rm -f "$CANDIDATE_BIN" "$CANDIDATE_PLIST"
}

on_exit() {
  STATUS=$?
  trap - EXIT HUP INT TERM
  if [ "$STATUS" -ne 0 ] && [ "$ACTIVATION_STARTED" -eq 1 ]; then
    printf 'Webot activation failed; restoring %s\n' "$BACKUP_DIR" >&2
    restore_previous || true
  fi
  cleanup
  exit "$STATUS"
}

trap on_exit EXIT
trap 'exit 1' HUP INT TERM

ACTIVATION_STARTED=1
/bin/launchctl bootout "$SERVICE" 2>/dev/null || true
mv "$CANDIDATE_BIN" "$BIN_DIR/webot"
mv "$CANDIDATE_PLIST" "$PLIST"
chmod 700 "$BIN_DIR/webot"
chmod 600 "$PLIST"

if ! /bin/launchctl bootstrap "gui/$UID_VALUE" "$PLIST"; then
  sleep 1
  /bin/launchctl bootstrap "gui/$UID_VALUE" "$PLIST"
fi
/bin/launchctl kickstart -k "$SERVICE"

ATTEMPT=0
while [ "$ATTEMPT" -lt 15 ]; do
  if /usr/bin/curl -fsS --max-time 2 http://127.0.0.1:18120/health >/dev/null; then
    ACTIVATION_STARTED=0
    printf 'Webot installed: http://127.0.0.1:18120\n'
    exit 0
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

printf 'Webot did not become healthy; check %s/stderr.log\n' "$LOG_DIR" >&2
exit 1
