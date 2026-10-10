#!/usr/bin/env node
/*
 * Usage: node tools/gen.js <stock performanceconfig.xml> <stock game_policy.xml> <tuning.json> <out.xml> [pkg]
 *
 * Writes the tuned performanceconfig.xml (plus game_policy.xml next to it when the
 * Beast memory boost is enabled) and prints what changed for the "default"
 * policy (games not listed in game_policy.xml) and, optionally, one package.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const PerfGen = require(path.join(__dirname, '..', 'lib', 'perfgen.js'));

function fmt(type, triple) {
  if (type === 'GPU') {
    return triple.map((lvl) => (lvl < 0 ? '-' : PerfGen.DEFAULT_TABLES.GPU[lvl] + 'MHz')).join(' / ');
  }
  return triple.map((khz) => (khz < 0 ? '-' : (khz / 1e6).toFixed(2))).join(' / ');
}

function main(argv) {
  const [perfPath, gamePath, configPath, outPath, pkg] = argv;
  if (!outPath) {
    console.error('usage: gen.js <performanceconfig.xml> <game_policy.xml> <tuning.json> <out.xml> [pkg]');
    process.exit(2);
  }
  const result = PerfGen.generate(
    fs.readFileSync(perfPath, 'utf8'),
    fs.readFileSync(gamePath, 'utf8'),
    JSON.parse(fs.readFileSync(configPath, 'utf8')),
  );
  fs.writeFileSync(outPath, result.xml);
  if (result.gameXml) {
    const gameOut = path.join(path.dirname(outPath), 'game_policy.xml');
    fs.writeFileSync(gameOut, result.gameXml);
    console.log(`Beast memory boost: ${result.stats.boostedGames} games -> ${gameOut}`);
  }

  console.log(`version ${result.version}, ${result.stats.changed} entries changed across ${result.stats.apps} game policies`);
  for (const target of ['default', pkg].filter(Boolean)) {
    console.log(`\n[${target}]  (max / min / boost; CPU in GHz)`);
    result.changes
      .filter((c) => c.pkg === target)
      .forEach((c) => console.log(`  ${c.mode.padEnd(9)} tier${c.tier} temp=${String(c.temp).padEnd(5)} ${c.type.padEnd(8)} ${fmt(c.type, c.from)}  ->  ${fmt(c.type, c.to)}`));
  }
}

main(process.argv.slice(2));
