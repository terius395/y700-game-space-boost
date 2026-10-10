#!/system/bin/sh
# Started by uninstall.sh from a copy outside the module dir. Waits until com.zui.pp's
# storage is readable, puts the stock configs back, then removes itself.
MODDIR=${0%/*}/..
. "$MODDIR/common.sh"

until [ "$(getprop sys.boot_completed)" = "1" ]; do
  sleep 5
done

if wait_pp_data 1800; then
  restored=0
  if grep -q "$MARKER" "$PP_DATA" 2>/dev/null; then
    write_pp_data "$STOCK_PERF" && restored=1
  fi
  if grep -q "$MARKER" "$PP_GAME_DATA" 2>/dev/null; then
    write_pp_game "$STOCK_GAME" && restored=1
  fi
  [ $restored = 1 ] && restart_pp
fi

rm -rf /data/adb/y700_perf_tuner_restore
