#!/usr/bin/env node
/* Tests for lib/perfgen.js. Run: npm test (no dependencies). */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../lib/perfgen.js');

const ROOT = path.join(__dirname, '..');
const stockPerf = fs.readFileSync(path.join(ROOT, 'stock', 'performanceconfig.xml'), 'utf8');
const stockGame = fs.readFileSync(path.join(ROOT, 'stock', 'game_policy.xml'), 'utf8');

let failed = 0;
function check(cond, name) {
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
  if (!cond) failed++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nums = (s) => s.split(' ').map(Number);
const nearest = (t, w) => t.reduce((b, f) => (Math.abs(f - w) < Math.abs(b - w) ? f : b), t[0]);

// Freq entry for one id inside one <Type> section of a generated config.
function entry(xml, type, id) {
  const section = xml.split('<Type name = "' + type + '">')[1].split('</Type>')[0];
  return new RegExp('level = "' + id + '">([^<]*)<').exec(section)[1];
}

// ---- hardware detection (TB322FC sysfs readings) ----
const gen4 = [
  { policy: 'policy6', cpus: [6, 7], freqs: nums('1017600 1209600 1401600 1689600 1958400 2246400 2438400 2649600 2841600 3072000 3283200 3513600 3801600 4089600 4204800 4320000') },
  { policy: 'policy0', cpus: [0, 1, 2, 3, 4, 5], freqs: nums('384000 556800 748800 960000 1152000 1363200 1555200 1785600 1996800 2227200 2400000 2745600 2918400 3072000 3321600 3532800') },
];
const gpuHz = nums('1100000000 1050000000 967000000 900000000 832000000 734000000 660000000 607000000 525000000 443000000 389000000 342000000 222000000 160000000');
const d4 = P.detectTables(gen4, gpuHz);
check(['BigCore', 'MegaCore', 'GPU'].every((k) => eq(d4.tables[k], P.DEFAULT_TABLES[k])), 'TB322FC tables detected == built-in tables');
check(d4.clusters.map((c) => c.type + ':' + c.policy).join(',') === 'BigCore:policy0,MegaCore:policy6', 'clusters sorted by first CPU');
const d3 = P.detectTables([
  { policy: 'policy0', cpus: [0, 1], freqs: [300000, 2000000] },
  { policy: 'policy2', cpus: [2, 3, 4], freqs: [500000, 3000000] },
  { policy: 'policy7', cpus: [7], freqs: [600000, 3300000] },
], [900000000]);
check(d3.clusters.map((c) => c.type).join(',') === 'LittleCore,BigCore,MegaCore', '3 clusters -> Little/Big/Mega');
check(P.detectTables([], [1]) === null && P.detectTables(gen4, []) === null, 'unknown layout -> null');

// ---- WebUI preset ratios reproduce the Gen4 values ----
const T = d4.tables;
const top = (t) => t[t.length - 1];
check(nearest(T.BigCore, top(T.BigCore) * 0.87) === 3072000 && nearest(T.MegaCore, top(T.MegaCore) * 0.814) === 3513600, 'preset Mượt hơn -> 3.07 / 3.51 GHz');
check(nearest(T.BigCore, top(T.BigCore) * 0.506) === 1785600 && nearest(T.MegaCore, top(T.MegaCore) * 0.454) === 1958400 && nearest(T.GPU, T.GPU[0] * 0.48) === 525, 'preset Tiết kiệm hơn -> 1.79 / 1.96 GHz, 525 MHz');
check(nearest(T.BigCore, top(T.BigCore) * 0.827) === 2918400, 'preset Hiệu năng min -> 2.92 GHz');

// ---- generation on the stock TB322FC files ----
const base = { version: '290000000000', modes: { balance: { bigMax: 3072000, megaMax: 3513600, gpuMaxMhz: 900, gpuMinMhz: 734 } } };
const r = P.generate(stockPerf, stockGame, base);
check(r.xml.includes(P.GENERATED_MARKER) && /<PerformanceConfig[^>]*version="290000000000"/.test(r.xml), 'marker and version written');
check(entry(r.xml, 'BigCore', '92') === '3072000_1555200_3072000', 'PUBG Balance tier0 BigCore');
check(entry(r.xml, 'MegaCore', '92') === '3513600_1209600_3513600', 'PUBG Balance tier0 MegaCore');
check(entry(r.xml, 'GPU', '92') === '3_5_-1', 'PUBG Balance tier0 GPU 900/734 MHz -> levels 3/5');
check(entry(r.xml, 'BigCore', '94') === '2745600_1152000_2745600', 'hotter tier scaled with the same ratio');
check(r.gameXml === null, 'game_policy.xml untouched without memBoost');
check(r.xml === P.generate(stockPerf, stockGame, Object.assign({}, base, { tables: d4.tables })).xml, 'detected tables give identical output');
let threw = false;
try { P.generate(r.xml, stockGame, base); } catch (e) { threw = true; }
check(threw, 'refuses an already generated input');

// lock: every tier copies the coolest one
const locked = P.generate(stockPerf, stockGame, { version: '1', modes: { beast: { lock: true } } });
check(['100', '101', '102', '103'].every((id) => entry(locked.xml, 'MegaCore', id) === entry(locked.xml, 'MegaCore', '100')), 'lock: PUBG Beast tiers all equal tier0');

// memBoost: perflock items + per-game references
const boosted = P.generate(stockPerf, stockGame, { version: '1', modes: { beast: { memBoost: true } } });
check(boosted.xml.includes('<Item name = "' + P.BEAST_BOOST_ITEM + '">') && boosted.xml.includes('<Item name = "' + P.RELEASE_ITEM + '">'), 'memBoost: special items added');
check(!/SpecialBoostConfig">[^<]*\s(NoBoost|SavageBoost)<\//.test(boosted.gameXml) && boosted.gameXml.includes(P.GENERATED_MARKER), 'memBoost: every Beast boost points at the new item');

// ---- unlimited (-1) hotter tiers ----
const tinyPerf = `<?xml version="1.0" encoding="utf-8"?>
<PerformanceConfig model="T" version="1">
    <PerformanceSpecialList>
    </PerformanceSpecialList>
    <GameLimitConfig>
        <Type name = "TempLevel">
            <Temp level ="-1000">default</Temp>
        </Type>
        <Type name = "BigCore">
            <Freq level = "1">2000000_1000000_-1</Freq>
            <Freq level = "2">-1_-1_-1</Freq>
        </Type>
        <Type name = "GPU">
            <Freq level = "1">5_11_-1</Freq>
            <Freq level = "2">-1_-1_-1</Freq>
        </Type>
    </GameLimitConfig>
</PerformanceConfig>
`;
const tinyGame = '<AppPolicy version="1"><AppList type="game"><App name="d" pkg="default">' +
  '<Attribute name="LimitConfig">-1000:1_1|4:2_2 -1000:1_1 -1000:1_1</Attribute></App></AppList></AppPolicy>';
const tiny = P.generate(tinyPerf, tinyGame, {
  version: '1', tables: { BigCore: [1000000, 1500000, 2000000, 3000000] },
  modes: { balance: { bigMax: 3000000, bigMin: 1500000, gpuMaxMhz: 900, gpuMinMhz: 734 } },
});
check(entry(tiny.xml, 'BigCore', '2') === '3000000_-1_-1', 'unlimited hot max is capped at the base max, unset min stays unset');
check(entry(tiny.xml, 'GPU', '2') === '3_-1_-1', 'GPU: unlimited hot max level capped, unset min level stays unset');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
