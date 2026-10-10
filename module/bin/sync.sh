#!/system/bin/sh
# Re-apply the saved tuning to com.zui.pp. service.sh does this on every boot; the
# WebUI only offers it when status.sh reports the copies out of sync.
MODDIR=${0%/*}/..
. "$MODDIR/common.sh"

if sync_pp_data; then
  restart_pp
  echo "re-applied saved tuning"
else
  echo "already up to date"
fi
protect_pp_data
