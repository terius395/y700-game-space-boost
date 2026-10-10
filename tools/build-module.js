#!/usr/bin/env node
/*
 * Builds the KernelSU/Magisk module zip:
 *   module/ template + lib/perfgen.js (for the WebUI)
 *   + stock/ configs + system/etc/performanceconfig.xml generated from config/tuning.json
 *
 * Usage: node tools/build-module.js [tuning.json]   (or: npm run build)
 * Output: dist/y700_perf_tuner-<version>.zip, version taken from module/module.prop
 * Needs only Node.js 18+.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const PerfGen = require('../lib/perfgen.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'y700_perf_tuner');

// Magisk-compatible installer stub; KernelSU uses its own installer and only runs customize.sh.
const UPDATE_BINARY = `#!/sbin/sh
umask 022
ui_print() { echo "$1"; }
OUTFD=$2
ZIPFILE=$3
mount /data 2>/dev/null
[ -f /data/adb/magisk/util_functions.sh ] || { ui_print "Install from Magisk or KernelSU"; exit 1; }
. /data/adb/magisk/util_functions.sh
install_module
exit 0
`;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (/\.(sh|prop)$/.test(entry.name)) {
      // shell scripts must reach the device with LF endings
      fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n'));
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    });
}

// Minimal zip writer (deflate, UTF-8 names, fixed 1980-01-01 timestamps so builds
// are reproducible). Scripts get 0755 in the Unix attributes.
function zipDir(dir, zipPath) {
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  const local = [];
  const central = [];
  let offset = 0;
  const names = listFiles(dir);
  for (const rel of names) {
    const data = fs.readFileSync(path.join(dir, rel));
    const name = Buffer.from(rel, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const crc = crc32(data);
    const mode = /\.sh$|update-binary$/.test(rel) ? 0o100755 : 0o100644;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4); // made by Unix, zip 2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...local, centralBuf, end]));
}

function main() {
  const tuningPath = process.argv[2] || path.join(ROOT, 'config', 'tuning.json');
  const stockPerf = fs.readFileSync(path.join(ROOT, 'stock', 'performanceconfig.xml'), 'utf8');
  const stockGame = fs.readFileSync(path.join(ROOT, 'stock', 'game_policy.xml'), 'utf8');
  const tuning = JSON.parse(fs.readFileSync(tuningPath, 'utf8'));

  fs.rmSync(STAGE, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'module'), STAGE);
  fs.copyFileSync(path.join(ROOT, 'lib', 'perfgen.js'), path.join(STAGE, 'webroot', 'perfgen.js'));
  copyDir(path.join(ROOT, 'stock'), path.join(STAGE, 'stock'));
  fs.writeFileSync(path.join(STAGE, 'tuning.json'), JSON.stringify(tuning, null, 2) + '\n');

  const result = PerfGen.generate(stockPerf, stockGame, tuning);
  fs.mkdirSync(path.join(STAGE, 'system', 'etc'), { recursive: true });
  fs.writeFileSync(path.join(STAGE, 'system', 'etc', 'performanceconfig.xml'), result.xml);
  if (result.gameXml) {
    fs.writeFileSync(path.join(STAGE, 'system', 'etc', 'game_policy.xml'), result.gameXml);
  }
  fs.writeFileSync(path.join(STAGE, 'stock.md5'),
    crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'stock', 'performanceconfig.xml'))).digest('hex') + '\n');

  const metaDir = path.join(STAGE, 'META-INF', 'com', 'google', 'android');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'update-binary'), UPDATE_BINARY);
  fs.writeFileSync(path.join(metaDir, 'updater-script'), '#MAGISK\n');

  const version = /version=(.+)/.exec(fs.readFileSync(path.join(STAGE, 'module.prop'), 'utf8'))[1].trim();
  const zipPath = path.join(DIST, `y700_perf_tuner-${version}.zip`);
  fs.rmSync(zipPath, { force: true });
  zipDir(STAGE, zipPath);

  console.log(`config version ${result.version}, ${result.stats.changed} entries changed`);
  console.log(`built ${path.relative(ROOT, zipPath)}`);
}

main();
