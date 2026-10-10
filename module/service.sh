#!/system/bin/sh
# late_start service: make sure com.zui.pp runs on the tuned config.
MODDIR=${0%/*}
. "$MODDIR/common.sh"

until [ "$(getprop sys.boot_completed)" = "1" ]; do
  sleep 2
done
sleep 5
if ! wait_pp_data; then
  log "boot: $PP_DATA not readable (storage still locked?), skipped"
  exit 0
fi

# With a mounted overlay com.zui.pp already copied it (higher version) into its
# data dir. On Magica late-load root nothing is mounted, so this does the copy.
if sync_pp_data; then
  restart_pp
fi
protect_pp_data
log "boot: overlay=$(xml_version "$SYS_PERF") data=$(xml_version "$PP_DATA") attr=$(lsattr "$PP_DATA" 2>/dev/null | cut -d' ' -f1)"
