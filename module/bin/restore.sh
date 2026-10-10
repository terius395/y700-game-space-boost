#!/system/bin/sh
# Put the stock configs back into com.zui.pp without uninstalling the module.
# The overlay files are removed too, so from the next boot /system is stock again.
MODDIR=${0%/*}/..
. "$MODDIR/common.sh"

[ -f "$STOCK_PERF" ] && [ -f "$STOCK_GAME" ] || { echo "stock copy missing"; exit 1; }

# A mounted overlay stays until reboot. Give the mounted inode stock content
# first, otherwise com.zui.pp sees a newer /system file and copies it back.
[ -f "$MOD_PERF" ] && cat "$STOCK_PERF" > "$MOD_PERF" && rm -f "$MOD_PERF"
[ -f "$MOD_GAME" ] && cat "$STOCK_GAME" > "$MOD_GAME" && rm -f "$MOD_GAME"

write_pp_data "$STOCK_PERF" || { echo "com.zui.pp data copy missing: $PP_DATA"; exit 1; }
if grep -q "$MARKER" "$PP_GAME_DATA" 2>/dev/null; then
  write_pp_game "$STOCK_GAME" || { echo "failed to restore $PP_GAME_DATA"; exit 1; }
fi
# forget the saved tuning so the WebUI and future boots stay on stock
rm -f "$MODDIR/tuning.json"
mirror_to_staged
restart_pp
log "restored stock config"
echo "restored stock config (version $(xml_version "$STOCK_PERF"))"
