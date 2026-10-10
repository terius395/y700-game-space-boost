#!/system/bin/sh
# Runs when the module is removed. com.zui.pp keeps its own copies of the configs,
# and the stock /system files have lower versions, so the stock copies must go back.
# The root manager may run this early in boot, before com.zui.pp's storage is
# unlocked, and deletes the module dir right afterwards. So copy what the restore
# needs out of the module dir and let a detached script finish once storage is ready.
MODDIR=${0%/*}
RESTORE=/data/adb/y700_perf_tuner_restore

rm -rf "$RESTORE"
mkdir -p "$RESTORE/stock" "$RESTORE/bin"
cp -f "$MODDIR/common.sh" "$RESTORE/"
cp -f "$MODDIR/stock/performanceconfig.xml" "$MODDIR/stock/game_policy.xml" "$RESTORE/stock/"
cp -f "$MODDIR/bin/finish-uninstall.sh" "$RESTORE/bin/"
nohup sh "$RESTORE/bin/finish-uninstall.sh" >/dev/null 2>&1 &
