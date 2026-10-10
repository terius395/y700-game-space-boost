#!/system/bin/sh
# Usage: apply.sh <generated performanceconfig.xml> [generated game_policy.xml]
# Called by the WebUI after it regenerates the config. Without the second file the
# stock game_policy.xml is put back (Beast memory boost off).
MODDIR=${0%/*}/..
. "$MODDIR/common.sh"

for f in "$1" ${2:+"$2"}; do
  if [ ! -f "$f" ] || ! grep -q "$MARKER" "$f"; then
    echo "not a generated config: $f"
    exit 1
  fi
done

# Work from private copies: an argument may be the overlay file itself, and
# "cat x > x" truncates it.
mkdir -p "$MODDIR/tmp" "$MODDIR/system/etc"
perf_src="$MODDIR/tmp/apply.$$.perf.xml"
game_src="$MODDIR/tmp/apply.$$.game.xml"
trap 'rm -f "$perf_src" "$game_src"' EXIT
cp "$1" "$perf_src" || exit 1
[ -n "$2" ] && { cp "$2" "$game_src" || exit 1; }

# install_overlay <src> <dst>: in place when it exists, so a mounted overlay sees it
install_overlay() {
  if [ -f "$2" ]; then
    cat "$1" > "$2"
  else
    cp "$1" "$2"
    chmod 0644 "$2"
    chcon u:object_r:system_file:s0 "$2"
  fi
}

install_overlay "$perf_src" "$MOD_PERF"
write_pp_data "$MOD_PERF" || { echo "com.zui.pp data copy missing: $PP_DATA"; exit 1; }

if [ -n "$2" ]; then
  install_overlay "$game_src" "$MOD_GAME"
  write_pp_game "$MOD_GAME" || { echo "com.zui.pp data copy missing: $PP_GAME_DATA"; exit 1; }
  echo "Beast memory boost on"
else
  rm -f "$MOD_GAME"
  if grep -q "$MARKER" "$PP_GAME_DATA" 2>/dev/null; then
    write_pp_game "$STOCK_GAME" || { echo "failed to restore $PP_GAME_DATA"; exit 1; }
  fi
fi

mirror_to_staged
restart_pp
log "applied version $(xml_version "$MOD_PERF") game=$(xml_version "$PP_GAME_DATA")"
echo "applied version $(xml_version "$MOD_PERF")"
