#!/system/bin/sh
# Prints key=value lines describing what com.zui.pp is running, for the WebUI.
MODDIR=${0%/*}/..
. "$MODDIR/common.sh"

same() { [ "$(file_md5 "$1")" = "$(file_md5 "$2")" ] && echo 1 || echo 0; }

echo "perf_data=$(xml_version "$PP_DATA")"
echo "perf_mod=$([ -f "$MOD_PERF" ] && xml_version "$MOD_PERF")"
echo "perf_sync=$([ -f "$MOD_PERF" ] && same "$MOD_PERF" "$PP_DATA" || echo 0)"
echo "perf_tuned=$(grep -q "$MARKER" "$PP_DATA" 2>/dev/null && echo 1 || echo 0)"
echo "game_mod=$([ -f "$MOD_GAME" ] && echo 1 || echo 0)"
if [ -f "$MOD_GAME" ]; then
  echo "game_sync=$(same "$MOD_GAME" "$PP_GAME_DATA")"
else
  echo "game_sync=$(grep -q "$MARKER" "$PP_GAME_DATA" 2>/dev/null && echo 0 || echo 1)"
fi
echo "immutable=$(lsattr "$PP_DATA" 2>/dev/null | cut -d' ' -f1 | grep -q i && echo 1 || echo 0)"
