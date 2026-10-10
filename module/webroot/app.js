/* WebUI for the KernelSU module. Uses the ksu.exec bridge provided by the manager. */
'use strict';

const MODDIR = '/data/adb/modules/y700_perf_tuner';
const VERIFIED_MODELS = ['TB322FC']; // Legion Y700 Gen4, measured end to end

// Display order follows Game Assistant's sidebar. The config keys (and their index in
// game_policy.xml, see PerfGen.MODES) stay balance / powersave / beast.
const MODES = [
  { id: 'powersave', name: 'Tiết kiệm pin', sub: 'Battery Saver', desc: 'Ưu tiên pin và nhiệt độ thấp.' },
  { id: 'balance', name: 'Cân bằng', sub: 'Balance', desc: 'Chế độ mặc định khi chơi game.' },
  { id: 'beast', name: 'Hiệu năng', sub: 'Performance', desc: 'Mạnh nhất. Máy nóng và tốn pin hơn.' },
];

const CLUSTER_NAMES = {
  LittleCore: 'Nhân tiết kiệm', BigCore: 'Nhân hiệu năng', TitanCore: 'Nhân hiệu năng cao', MegaCore: 'Nhân siêu cao',
};
const PREFIX = Object.fromEntries(Object.entries(PerfGen.CPU_FIELDS).map(([k, v]) => [v, k]));

// One-tap presets as fractions of each cluster's hardware maximum, so they work on any
// SoC. On TB322FC they land on 3.07/3.51 GHz (Mượt hơn), 1.79/1.96 GHz + 525 MHz
// (Tiết kiệm hơn) and 2.92/3.51 GHz minimum (Hiệu năng · Tối đa).
// cpu: ratio for every cluster except the top one, prime: top cluster, gpu: GPU max.
const PRESETS = {
  balance: [
    { name: 'Mặc định Lenovo' },
    { name: 'Mượt hơn', max: { cpu: 0.87, prime: 0.814 } },
    { name: 'Tối đa', max: { cpu: 1, prime: 1, gpu: 1 } },
  ],
  powersave: [
    { name: 'Mặc định Lenovo' },
    { name: 'Tiết kiệm hơn', max: { cpu: 0.506, prime: 0.454, gpu: 0.48 } },
  ],
  beast: [
    { name: 'Mặc định Lenovo' },
    { name: 'Tối đa', max: { cpu: 1, prime: 1, gpu: 1 }, min: { cpu: 0.827, prime: 0.814 } },
  ],
};

const state = {
  stockPerf: '', stockGame: '', apps: [], limits: {}, order: [],
  tables: PerfGen.DEFAULT_TABLES, clusters: [], groups: [], freqKeys: [],
  saved: null, draft: null, mode: 'balance', tempPath: '', busy: false,
  needsSave: false, // the running config came from another firmware and must be regenerated
  minOpen: {}, // per mode: whether "Xung tối thiểu" stays expanded across re-renders
};

// ---------- helpers ----------

function exec(cmd) {
  return new Promise((resolve) => {
    const cb = 'exec_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    window[cb] = (errno, stdout, stderr) => {
      delete window[cb];
      resolve({ errno, stdout, stderr });
    };
    ksu.exec(cmd, '{}', cb);
  });
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  (children || []).forEach((c) => c && node.appendChild(c));
  return node;
}

let toastTimer;
function toast(text, isError) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 6000 : 3500);
}

function parseKeyValues(text) {
  const out = {};
  text.split('\n').forEach((line) => {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return out;
}

const ghz = (khz) => (khz / 1e6).toFixed(2) + ' GHz';
const fmt = (type, v) => (v === undefined || v < 0 ? 'không giới hạn'
  : type === 'GPU' ? (state.tables.GPU[v] !== undefined ? state.tables.GPU[v] + ' MHz' : 'level ' + v) : ghz(v));

function emptyTuning() {
  return { version: 'auto', scaleHotTiers: true, modes: { balance: {}, powersave: {}, beast: {} } };
}

// Hotter thermal tiers always scale with the chosen limit; "lock" is the way to stop
// the step-down, so the WebUI does not expose scaleHotTiers.
function normalize(tuning) {
  const out = emptyTuning();
  MODES.forEach(({ id }) => {
    const src = (tuning.modes && tuning.modes[id]) || {};
    state.freqKeys.forEach((k) => { if (src[k] !== undefined && src[k] !== null && src[k] !== '') out.modes[id][k] = Number(src[k]); });
    if (src.lock) out.modes[id].lock = true;
    if (id === 'beast' && src.memBoost) out.modes[id].memBoost = true;
  });
  return out;
}

function sameTuning(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

// Lenovo's value for the coolest tier of the reference game, so users can compare.
function stockValue(modeIndex, type, idx) {
  const app = state.apps.find((a) => a.pkg === document.getElementById('ref-app').value);
  const tiers = app && app.modes[modeIndex];
  const pos = state.order.indexOf(type);
  const triple = tiers && tiers[0] && state.limits[type] && state.limits[type][tiers[0].ids[pos]];
  return triple ? triple[idx] : undefined;
}

function versionTime(v) {
  // 29yyMMddHHmm
  const m = /^29(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(v || '');
  return m ? m[3] + '/' + m[2] + ' ' + m[4] + ':' + m[5] : '';
}

// ---------- hardware ----------

// Reads the cpufreq clusters and GPU levels of this device. Falls back to the TB322FC
// tables when sysfs cannot be read.
async function detectHardware() {
  const r = await exec('cd /sys/devices/system/cpu/cpufreq && for p in policy*; do ' +
    'echo "$p|$(cat $p/related_cpus)|$(cat $p/scaling_available_frequencies)"; done; ' +
    'echo "gpu|$(cat /sys/class/kgsl/kgsl-3d0/gpu_available_frequencies)"');
  const policies = [];
  let gpu = [];
  r.stdout.trim().split('\n').forEach((line) => {
    const [name, a, b] = line.split('|');
    const nums = (s) => (s || '').trim().split(/\s+/).filter(Boolean).map(Number);
    if (name === 'gpu') gpu = nums(a);
    else if (name && name.startsWith('policy')) policies.push({ policy: name, cpus: nums(a), freqs: nums(b) });
  });
  const detected = PerfGen.detectTables(policies, gpu);
  if (detected) {
    state.tables = detected.tables;
    state.clusters = detected.clusters;
  } else {
    state.tables = PerfGen.DEFAULT_TABLES;
    state.clusters = [
      { type: 'BigCore', policy: 'policy0', cores: 6, max: 3532800 },
      { type: 'MegaCore', policy: 'policy6', cores: 2, max: 4320000 },
    ];
  }
  // Only clusters the stock config actually has a table for can be tuned.
  const tunable = state.clusters.filter((c) => state.limits[c.type]);
  state.groups = tunable.map((c) => ({
    type: c.type, name: CLUSTER_NAMES[c.type], sub: c.cores + ' nhân · tối đa ' + ghz(c.max),
    max: PREFIX[c.type] + 'Max', min: PREFIX[c.type] + 'Min',
  }));
  state.groups.push({ type: 'GPU', name: 'GPU', sub: 'tối đa ' + state.tables.GPU[0] + ' MHz', max: 'gpuMaxMhz', min: 'gpuMinMhz' });
  state.freqKeys = state.groups.flatMap((g) => [g.max, g.min]);
}

// Closest available frequency, so sparse tables do not undershoot a preset.
function nearest(table, want) {
  return table.reduce((best, f) => (Math.abs(f - want) < Math.abs(best - want) ? f : best), table[0]);
}

// Turns a preset's ratios into concrete values for this device's tables.
function presetValues(preset) {
  const out = {};
  const top = state.groups.filter((g) => g.type !== 'GPU').slice(-1)[0];
  const apply = (ratios, key) => {
    if (!ratios) return;
    state.groups.forEach((g) => {
      const table = state.tables[g.type];
      if (g.type === 'GPU') {
        if (ratios.gpu === undefined || key === 'min') return;
        out[g[key]] = nearest(table, table[0] * ratios.gpu);
      } else {
        const ratio = g === top ? ratios.prime : ratios.cpu;
        if (ratio === undefined) return;
        out[g[key]] = nearest(table, table[table.length - 1] * ratio);
      }
    });
  };
  apply(preset.max, 'max');
  apply(preset.min, 'min');
  return out;
}

// ---------- rendering ----------

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  MODES.forEach((m) => {
    const b = el('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(state.mode === m.id),
      onclick: () => { state.mode = m.id; renderTabs(); renderPanel(); },
    });
    b.appendChild(document.createTextNode(m.name));
    b.appendChild(el('small', { text: m.sub }));
    tabs.appendChild(b);
  });
}

function renderLiveTiles() {
  const live = document.getElementById('live');
  live.innerHTML = '';
  const tile = (id, label, withRange) => el('div', { class: 'stat' }, [
    el('span', { class: 'label', text: label }),
    el('span', { class: 'value', id: 'live-' + id, text: '–' }),
    withRange ? el('span', { class: 'range', id: 'range-' + id }) : null,
  ]);
  state.clusters.forEach((c) => live.appendChild(tile(c.policy, (CLUSTER_NAMES[c.type] || c.type) + ' (' + c.cores + ' nhân)', true)));
  live.appendChild(tile('gpu', 'GPU'));
  live.appendChild(tile('temp', 'Nhiệt độ máy'));
}

function freqSelect(type, key, modeCfg, onChange) {
  const select = el('select', { onchange: () => onChange(select.value) });
  select.add(new Option('Theo Lenovo', ''));
  const values = type === 'GPU' ? state.tables.GPU.slice() : state.tables[type].slice().reverse();
  values.forEach((v, i) => {
    const label = (type === 'GPU' ? v + ' MHz' : ghz(v)) + (i === 0 ? ' · tối đa' : '');
    select.add(new Option(label, v));
  });
  if (modeCfg[key] !== undefined) select.value = String(modeCfg[key]);
  return select;
}

function fieldRow(label, type, key, idx, modeIndex, modeCfg) {
  const select = freqSelect(type, key, modeCfg, (v) => {
    if (v === '') delete modeCfg[key]; else modeCfg[key] = Number(v);
    renderPanel();
  });
  const stock = stockValue(modeIndex, type, idx);
  return el('label', { class: 'field' }, [
    el('span', { text: label }), select,
    el('span', { class: 'hint', text: 'Lenovo: ' + fmt(type, stock) }),
  ]);
}

function toggleRow(title, desc, checked, warning, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const row = el('label', { class: 'toggle' }, [
    el('span', { class: 't-title', text: title }),
    el('span', { class: 'switch' }, [input, el('span', { class: 'slider' })]),
    el('span', { class: 't-desc', text: desc }),
  ]);
  if (checked && warning) row.appendChild(el('span', { class: 'warn-text', text: warning }));
  return row;
}

function renderPanel() {
  const panel = document.getElementById('mode-panel');
  const mode = MODES.find((m) => m.id === state.mode);
  const modeIndex = PerfGen.MODES.indexOf(mode.id); // position in game_policy.xml
  const cfg = state.draft.modes[mode.id];
  panel.innerHTML = '';
  panel.appendChild(el('p', { class: 'mode-desc', text: mode.desc }));

  // presets
  const chips = el('div', { class: 'chips' });
  let matched = false;
  PRESETS[mode.id].forEach((p) => {
    const values = presetValues(p);
    const active = state.freqKeys.every((k) => cfg[k] === values[k]);
    matched = matched || active;
    chips.appendChild(el('button', {
      class: 'chip' + (active ? ' active' : ''), text: p.name,
      onclick: () => {
        state.freqKeys.forEach((k) => delete cfg[k]);
        Object.assign(cfg, values);
        renderPanel();
      },
    }));
  });
  if (!matched) chips.appendChild(el('span', { class: 'chip active custom', text: 'Tùy chỉnh' }));
  panel.appendChild(chips);

  // max frequency per cluster
  state.groups.forEach((g) => {
    panel.appendChild(el('div', { class: 'group' }, [
      el('div', { class: 'group-head' }, [el('span', { class: 'group-name', text: g.name }), el('span', { class: 'group-sub', text: g.sub })]),
      fieldRow('Xung tối đa', g.type, g.max, 0, modeIndex, cfg),
    ]));
  });

  // minimum frequencies are rarely needed; start expanded only when one is set
  if (state.minOpen[mode.id] === undefined) {
    state.minOpen[mode.id] = state.groups.some((g) => cfg[g.min] !== undefined);
  }
  const minor = el('details', { class: 'minor' }, [el('summary', { text: 'Xung tối thiểu (nâng cao)' })]);
  minor.open = state.minOpen[mode.id];
  minor.addEventListener('toggle', () => { state.minOpen[mode.id] = minor.open; });
  minor.appendChild(el('p', {
    class: 'muted',
    text: 'CPU tự chạy trong khoảng tối thiểu – tối đa tùy độ nặng của game. ' +
      'Nâng mức tối thiểu giúp phản hồi nhanh hơn nhưng tốn pin và nóng hơn.',
  }));
  state.groups.forEach((g) => minor.appendChild(fieldRow(g.name, g.type, g.min, 1, modeIndex, cfg)));
  panel.appendChild(minor);

  // switches
  panel.appendChild(toggleRow(
    'Không giảm xung khi nóng',
    'Giữ nguyên cả xung tối đa và tối thiểu như lúc máy còn mát, dù máy nóng lên.',
    !!cfg.lock,
    'Máy có thể nóng trên 50°C khi chơi lâu, pin chai nhanh hơn. Chip vẫn được kernel bảo vệ ở 90–105°C.',
    (on) => { if (on) cfg.lock = true; else delete cfg.lock; renderPanel(); },
  ));
  if (mode.id === 'beast') {
    panel.appendChild(toggleRow(
      'Tăng tốc bộ nhớ',
      'Giữ RAM, cache và bộ lập lịch ở mức cao: giảm giật, FPS thấp nhất ổn định hơn.',
      !!cfg.memBoost,
      'Tốn pin hơn. Vẫn giữ khi chuyển sang Tiết kiệm pin cho tới khi thoát game hoặc chuyển Cân bằng.',
      (on) => { if (on) cfg.memBoost = true; else delete cfg.memBoost; renderPanel(); },
    ));
  }
  updateBar();
}

function updateBar() {
  const apply = document.getElementById('apply');
  const dirty = !sameTuning(state.draft, state.saved) || state.needsSave;
  apply.disabled = state.busy || !dirty;
  apply.textContent = state.busy ? 'Đang lưu…' : dirty ? 'Lưu & áp dụng' : 'Đã lưu';
}

// ---------- device state ----------

async function refreshStatus() {
  const r = await exec('sh ' + MODDIR + '/bin/status.sh');
  const s = parseKeyValues(r.stdout);
  const badge = document.getElementById('status-badge');
  const text = document.getElementById('status-text');
  const resync = document.getElementById('resync');
  resync.hidden = true;
  if (s.perf_mod && s.perf_sync === '1' && s.game_sync === '1') {
    badge.className = 'badge ok';
    badge.textContent = '✓ Đang hoạt động';
    const when = versionTime(s.perf_mod);
    text.textContent = (when ? 'Lưu lần cuối ' + when + '. ' : '') +
      (s.game_mod === '1' ? 'Tăng tốc bộ nhớ: bật.' : '');
  } else if (!s.perf_mod && s.perf_tuned === '0') {
    badge.className = 'badge';
    badge.textContent = 'Đang dùng Mặc định Lenovo';
    text.textContent = 'Chưa có tùy chỉnh nào được lưu.';
  } else if (!s.perf_mod) {
    // the system still runs a config generated from another firmware's stock file
    badge.className = 'badge warn';
    badge.textContent = '⚠ Cần lưu lại';
    text.textContent = 'Firmware đã thay đổi. Kiểm tra lại các mức xung rồi bấm "Lưu & áp dụng" để tạo cấu hình mới.';
    state.needsSave = true;
    updateBar();
  } else {
    badge.className = 'badge warn';
    badge.textContent = '⚠ Chưa áp dụng';
    text.textContent = 'Cài đặt đã lưu nhưng hệ thống chưa nạp. Bấm "Áp dụng lại".';
    resync.hidden = false;
  }
}

async function refreshLive() {
  if (document.hidden) return;
  const policies = state.clusters.map((c) => c.policy).join(' ');
  const r = await exec('C=/sys/devices/system/cpu/cpufreq; for p in ' + policies + '; do ' +
    'echo $(cat $C/$p/scaling_cur_freq) $(cat $C/$p/scaling_min_freq) $(cat $C/$p/scaling_max_freq); done; ' +
    'cat /sys/class/kgsl/kgsl-3d0/gpuclk; ' + (state.tempPath ? 'cat ' + state.tempPath : 'echo'));
  const lines = r.stdout.trim().split('\n');
  state.clusters.forEach((c, i) => {
    const [cur, min, max] = (lines[i] || '').split(' ').map(Number);
    document.getElementById('live-' + c.policy).textContent = cur ? ghz(cur) : '–';
    document.getElementById('range-' + c.policy).textContent = max ? 'giới hạn ' + (min / 1e6).toFixed(2) + '–' + (max / 1e6).toFixed(2) : '';
  });
  const gpu = Number(lines[state.clusters.length]);
  document.getElementById('live-gpu').textContent = gpu ? Math.round(gpu / 1e6) + ' MHz' : '–';
  const temp = Number(lines[state.clusters.length + 1]);
  document.getElementById('live-temp').textContent = temp ? (temp / 1000).toFixed(1) + ' °C' : '–';
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Command lines have a per-argument size limit, so large files go over in chunks.
async function writeFile(path, text) {
  const b64 = toBase64(text);
  let r = await exec(': > ' + path + '.b64');
  if (r.errno) throw new Error(r.stderr);
  for (let i = 0; i < b64.length; i += 60000) {
    r = await exec("printf '%s' '" + b64.slice(i, i + 60000) + "' >> " + path + '.b64');
    if (r.errno) throw new Error(r.stderr);
  }
  r = await exec('base64 -d ' + path + '.b64 > ' + path + ' && rm ' + path + '.b64');
  if (r.errno) throw new Error(r.stderr);
}

// ---------- actions ----------

async function apply() {
  state.busy = true;
  updateBar();
  try {
    const tuning = normalize(state.draft);
    // the detected tables are passed in but not saved: they belong to the device
    const result = PerfGen.generate(state.stockPerf, state.stockGame, Object.assign({}, tuning, { tables: state.tables }));
    await exec('mkdir -p ' + MODDIR + '/tmp');
    await writeFile(MODDIR + '/tuning.json', JSON.stringify(tuning, null, 2) + '\n');
    await writeFile(MODDIR + '/tmp/generated.xml', result.xml);
    let args = MODDIR + '/tmp/generated.xml';
    if (result.gameXml) {
      await writeFile(MODDIR + '/tmp/generated_game.xml', result.gameXml);
      args += ' ' + MODDIR + '/tmp/generated_game.xml';
    }
    const r = await exec('sh ' + MODDIR + '/bin/apply.sh ' + args);
    if (r.errno) throw new Error((r.stdout + r.stderr).trim());
    state.saved = normalize(tuning);
    state.needsSave = false;
    toast('Đã lưu. Nếu đang chơi, thoát hẳn game rồi mở lại để áp dụng.');
  } catch (e) {
    // tuning.json was written before apply.sh ran; put the previous one back
    await writeFile(MODDIR + '/tuning.json', JSON.stringify(normalize(state.saved), null, 2) + '\n').catch(() => {});
    toast('Không lưu được: ' + e.message, true);
  } finally {
    state.busy = false;
    updateBar();
    refreshStatus();
  }
}

async function restore() {
  if (!confirm('Khôi phục toàn bộ về Mặc định Lenovo?')) return;
  const r = await exec('sh ' + MODDIR + '/bin/restore.sh');
  if (r.errno) {
    toast('Không khôi phục được: ' + (r.stdout + r.stderr).trim(), true);
    return;
  }
  state.saved = emptyTuning();
  state.draft = emptyTuning();
  state.needsSave = false;
  renderPanel();
  refreshStatus();
  toast('Đã khôi phục Mặc định Lenovo. Nếu đang chơi, thoát hẳn game rồi mở lại.');
}

async function resync() {
  const r = await exec('sh ' + MODDIR + '/bin/sync.sh');
  toast(r.errno ? 'Lỗi: ' + r.stderr : 'Đã áp dụng lại cài đặt đã lưu.', !!r.errno);
  refreshStatus();
}

// ---------- init ----------

async function init() {
  if (typeof ksu === 'undefined') {
    document.getElementById('status-badge').textContent = 'Hãy mở trang này từ KernelSU';
    return;
  }
  const [perf, game, saved, temp, prop, model] = await Promise.all([
    exec('cat ' + MODDIR + '/stock/performanceconfig.xml'),
    exec('cat ' + MODDIR + '/stock/game_policy.xml'),
    exec('cat ' + MODDIR + '/tuning.json 2>/dev/null'),
    exec('for z in /sys/class/thermal/thermal_zone*; do [ "$(cat $z/type)" = user_front_temp ] && echo $z/temp && break; done'),
    exec('cat ' + MODDIR + '/module.prop'),
    exec('getprop ro.product.model'),
  ]);
  const meta = parseKeyValues(prop.stdout);
  document.getElementById('module-meta').textContent =
    [meta.version, meta.author && 'Tác giả: ' + meta.author].filter(Boolean).join(' · ');
  if (perf.errno || game.errno) {
    toast('Không đọc được cấu hình gốc trong ' + MODDIR + '/stock', true);
    return;
  }
  state.stockPerf = perf.stdout;
  state.stockGame = game.stdout;
  state.apps = PerfGen.parseGamePolicy(state.stockGame);
  ({ tables: state.limits, order: state.order } = PerfGen.parseLimitTables(state.stockPerf));
  state.tempPath = temp.stdout.trim();
  await detectHardware();

  const modelName = model.stdout.trim();
  if (modelName && !VERIFIED_MODELS.includes(modelName)) {
    const warn = document.getElementById('model-warn');
    warn.textContent = 'Model ' + modelName + ' chưa được kiểm chứng (đã kiểm chứng: Legion Y700 Gen4). ' +
      'Sau khi lưu, hãy kiểm tra xung trong game ở ô bên dưới.';
    warn.hidden = false;
  }

  let tuning = {};
  try { tuning = JSON.parse(saved.stdout || '{}'); } catch (e) { tuning = {}; }
  state.saved = normalize(tuning);
  state.draft = normalize(tuning);

  const ref = document.getElementById('ref-app');
  state.apps.forEach((a) => ref.add(new Option(a.pkg === 'default' ? 'Game khác (không có trong danh sách Lenovo)' : a.name + ' · ' + a.pkg, a.pkg)));
  ref.value = 'default';
  ref.addEventListener('change', renderPanel);

  document.getElementById('apply').addEventListener('click', apply);
  document.getElementById('restore').addEventListener('click', restore);
  document.getElementById('resync').addEventListener('click', resync);

  renderTabs();
  renderLiveTiles();
  renderPanel();
  refreshStatus();
  refreshLive();
  setInterval(refreshLive, 2000);
}

init();
