import { validateConfig, numberFields, getPath, setPath } from './core/config.mjs';
import { createPixelSampler } from './core/sensors.mjs';
import { Simulator } from './core/simulator.mjs';
import { Renderer } from './renderer.js';
import { ImuChart } from './charts.js';
import { staticMode } from './runtime-config.js';
import { createConfigStore } from './config-store.js';

const store = createConfigStore({ staticMode, baseUrl: new URL('./', import.meta.url).href, validate: validateConfig });

const $ = id => document.getElementById(id);
const canvas = $('track-canvas');
const chart = new ImuChart($('imu-chart'));
let config, draft, sim, renderer, controllerFactory;
let running = false, gesture = null, accumulator = 0, lastFrame = 0, lastUi = 0, lastSample = -1, toastTimer;
let irColumns = [];
const modeNames = { accelerometer: '加速度时序', gyroscope: '角速度时序', magnetometer: '磁场时序' };

function fitSensorBars() {
  const bars = $('sensor-bars'), width = bars.parentElement.clientWidth, count = irColumns.length;
  if (!width || !count) return;
  const style = getComputedStyle(bars);
  const minColumnWidth = parseFloat(style.getPropertyValue('--sensor-min-column-width'));
  const normalGap = parseFloat(style.getPropertyValue('--sensor-gap'));
  const compact = count * minColumnWidth + (count - 1) * normalGap > width;
  bars.classList.toggle('compact', compact);
  // 保持所有通道在同一行，密集模式下间隙也随每路可用空间收窄。
  bars.style.setProperty('--sensor-compact-gap', `${Math.min(2, width / count * 0.2)}px`);
}
const sensorResizeObserver = new ResizeObserver(fitSensorBars);
sensorResizeObserver.observe($('sensor-bars').parentElement);

function toast(message, error = false) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3200);
}
async function prepare(c) {
  validateConfig(c);
  const image = new Image();
  image.src = store.assetUrl(`tracks/${c.track.image.split(/[\\/]/).map(encodeURIComponent).join('/')}`);
  try { await image.decode(); } catch { throw new Error(`无法载入赛道图片：${c.track.image}，请检查配置路径和图片格式`); }
  const pixels = document.createElement('canvas'); pixels.width = image.naturalWidth; pixels.height = image.naturalHeight;
  const ctx = pixels.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const sampler = createPixelSampler(ctx.getImageData(0, 0, pixels.width, pixels.height), c.track.widthMm, c.track.backgroundReflectance);
  let module;
  try { module = await import(`${store.assetUrl(c.algorithm.module)}?t=${Date.now()}`); }
  catch (e) { throw new Error(`算法模块载入失败：${e.message}`); }
  if (typeof module.createController !== 'function') throw new Error('算法模块必须导出 createController()');
  const controller = module.createController();
  if (typeof controller !== 'function') throw new Error('createController() 必须返回同步更新函数');
  return { image, sampler, factory: module.createController, controller };
}
function install(c, assets) {
  config = structuredClone(c); controllerFactory = assets.factory;
  sim = new Simulator(config, assets.sampler, assets.controller);
  renderer = new Renderer(canvas, config, assets.image);
  setFollowCar(renderer.followCar);
  gesture = null; canvas.classList.remove('dragging');
  chart.history = []; lastSample = -1; accumulator = 0;
  setRunning(false);
  buildSensors(); fillSettings(config); syncControls();
  $('track-name').textContent = config.track.image.split(/[\\/]/).at(-1);
  $('track-size').textContent = `${config.track.widthMm} × ${renderer.trackHeight.toFixed(0)} mm`;
  const speedOptions = [...new Set([...(config.simulation.speedOptions ?? []), config.simulation.timeScale])].sort((a, b) => a - b);
  $('simulation-speed').replaceChildren(...speedOptions.map(speed => {
    const option = document.createElement('option'); option.value = speed; option.textContent = `${speed}×`; return option;
  }));
  $('simulation-speed').disabled = false;
  setTimeScale(config.simulation.timeScale);
  $('sample-rate').innerHTML = `${config.simulation.sensorHz}<span>Hz</span>`;
  $('footer-model').textContent = `差速运动学 · 固定步长 ${config.simulation.fixedStepHz} Hz`;
  $('history-label').textContent = `最近 ${config.view.historySeconds} s`;
  $('algorithm-path').textContent = config.algorithm.module;
  const routeDemo = config.algorithm.module === '/algorithms/route-demo.js';
  const imu6 = config.algorithm.inputProfile === 'ir5-imu6';
  $('imu-axis-label').textContent = imu6 ? '6-AXIS IMU' : '9-AXIS IMU';
  $('imu-heading').textContent = imu6 ? '六轴惯性导航' : '九轴惯性导航';
  document.querySelector('[data-imu="magnetometer"]').hidden = imu6;
  if (imu6 && chart.selected === 'magnetometer') {
    chart.selected = 'accelerometer'; $('chart-title').textContent = modeNames[chart.selected];
    document.querySelectorAll('[data-imu]').forEach(b => b.classList.toggle('active', b.dataset.imu === chart.selected));
  }
  $('algorithm-title').textContent = routeDemo ? '简单赛道 · 指定路线演示' : '接入你的控制策略';
  $('algorithm-description').textContent = routeDemo ? '5 路红外 + 六轴惯导；起步自动搜线，红外路口事件触发快速转向，重新捕获目标线后出弯。按简单赛道指定路线行驶并停车。' : '寻路逻辑预留为空，默认输出零速。修改算法模块后刷新页面。';
  $('toggle-run').disabled = false; $('loading').hidden = true;
  updatePanel();
}
function setRunning(value) {
  running = value; accumulator = 0;
  $('toggle-run').querySelector('use').setAttribute('href', value ? '#i-pause' : '#i-play');
  $('toggle-run').querySelector('span').textContent = value ? '暂停仿真' : '开始仿真';
  $('run-status').classList.toggle('running', value);
  $('run-status').innerHTML = `<i></i>${value ? '仿真运行中' : sim?.time > 0 ? '仿真已暂停' : '等待开始'}`;
}
function setTimeScale(speed) {
  if (!config || !Number.isFinite(speed) || speed < 0.1 || speed > 32) return;
  config.simulation.timeScale = speed;
  $('simulation-speed').value = String(speed);
  $('scale-label').textContent = `${speed}× 速度`;
  document.querySelector('[data-path="simulation.timeScale"]').value = speed;
  if (draft) draft.simulation.timeScale = speed;
}
$('simulation-speed').addEventListener('change', () => setTimeScale(Number($('simulation-speed').value)));
function syncControls() {
  for (const side of ['left', 'right']) {
    $(`${side}-rpm`).min = -config.wheels.maxRpm; $(`${side}-rpm`).max = config.wheels.maxRpm;
    $(`${side}-rpm`).value = sim.command[`${side}Rpm`]; $(`${side}-target`).textContent = Math.round(sim.command[`${side}Rpm`]);
  }
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === sim.mode));
  $('manual-controls').hidden = sim.mode !== 'manual'; $('algorithm-info').hidden = sim.mode !== 'algorithm';
}
function buildSensors() {
  $('sensor-bars').replaceChildren(); irColumns = [];
  for (let i = 0; i < config.infrared.count; i++) {
    const div = document.createElement('div'); div.className = 'sensor-column';
    div.innerHTML = `<span class="value">0.00</span><div class="bar-track"><div class="bar-threshold" style="bottom:${config.infrared.threshold * 100}%"></div><div class="bar-fill"></div></div><span class="sensor-name">${String(i + 1).padStart(2, '0')}</span>`;
    $('sensor-bars').append(div);
    irColumns.push({ element: div, value: div.querySelector('.value'), fill: div.querySelector('.bar-fill') });
  }
  $('ir-count').textContent = `${config.infrared.count} CHANNELS`; $('ir-total').textContent = config.infrared.count;
  $('threshold-label').textContent = `阈值 ${config.infrared.threshold.toFixed(2)} · ${config.infrared.detect === 'bright' ? '亮线' : '暗线'}检测`;
  $('sensor-bars').style.setProperty('--sensor-count', config.infrared.count);
  fitSensorBars();
}
function updatePanel() {
  if (!sim) return;
  const seconds = sim.time;
  $('runtime').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
  for (const [id, value, unit] of [['pos-x', sim.pose.xMm.toFixed(0), 'mm'], ['pos-y', sim.pose.yMm.toFixed(0), 'mm'], ['pose-heading', (sim.pose.headingRad * 180 / Math.PI).toFixed(1), '°'], ['speed', sim.motion.speedMps.toFixed(3), 'm/s']]) {
    $(id).replaceChildren(document.createTextNode(value), Object.assign(document.createElement('span'), { textContent: unit }));
  }
  let hits = 0;
  sim.infrared.forEach((s, i) => {
    const col = irColumns[i]; col.value.textContent = s.reflectance.toFixed(2); col.fill.style.height = `${s.reflectance * 100}%`; col.element.classList.toggle('hit', s.detected);
    col.element.title = `通道 ${i + 1} · 反射率 ${s.reflectance.toFixed(3)} · ${s.detected ? '命中' : '未命中'}`;
    if (s.detected) hits++;
  });
  $('ir-hits').textContent = hits;
  const degrees = sim.pose.headingRad * 180 / Math.PI;
  $('yaw').textContent = degrees.toFixed(1); $('compass-needle').setAttribute('transform', `rotate(${degrees} 43 43)`);
  for (const type of ['accelerometer', 'gyroscope', 'magnetometer']) for (const axis of ['x', 'y', 'z']) $(`${type}-${axis}`).textContent = sim.imu[type][axis].toFixed(2);
  $('left-actual').textContent = sim.wheels.leftRpm.toFixed(1); $('right-actual').textContent = sim.wheels.rightRpm.toFixed(1);
  $('algorithm-status').textContent = sim.controllerStatus || (sim.mode === 'algorithm' ? '就绪，点击开始仿真' : '');
  $('zoom-level').textContent = `${Math.round(renderer.camera.zoom / renderer.fitZoom * 100)}%`;
  const desired = 85 / renderer.camera.zoom, order = 10 ** Math.floor(Math.log10(desired));
  const rulerMm = [1, 2, 5, 10].map(v => v * order).reduce((prev, cur) => Math.abs(cur - desired) < Math.abs(prev - desired) ? cur : prev);
  $('ruler-label').textContent = `${rulerMm} mm`; $('ruler-line').style.width = `${rulerMm * renderer.camera.zoom}px`;
  chart.draw(sim);
}
function frame(timestamp) {
  const elapsed = Math.min((timestamp - (lastFrame || timestamp)) / 1000, config?.simulation.maxFrameDeltaSec ?? .1);
  lastFrame = timestamp;
  if (sim && renderer) {
    if (running && !gesture) {
      accumulator += elapsed * config.simulation.timeScale;
      const dt = 1 / config.simulation.fixedStepHz;
      while (accumulator + 1e-10 >= dt) {
        sim.step(dt); accumulator -= dt;
        if (sim.algorithmError) { setRunning(false); toast(`算法已停止：${sim.algorithmError}`, true); break; }
        if (sim.controllerComplete || sim.controllerFailed) {
          setRunning(false);
          $('run-status').innerHTML = `<i></i>${sim.controllerComplete ? '路线已完成' : '算法安全停止'}`;
          toast(sim.controllerStatus, sim.controllerFailed); updatePanel(); break;
        }
        captureSample();
      }
    }
    captureSample(); renderer.draw(sim, { suspendFollow: gesture?.type === 'car' });
    if (timestamp - lastUi >= 1000 / config.view.uiHz) { updatePanel(); lastUi = timestamp; }
  }
  requestAnimationFrame(frame);
}
function captureSample() {
  if (lastSample === sim.sampleId) return;
  if (chart.history.at(-1)?.time === sim.time) chart.history.pop();
  chart.add(sim); lastSample = sim.sampleId;
}

$('toggle-run').addEventListener('click', () => { if (sim && !gesture) setRunning(!running); });
$('reset').addEventListener('click', () => {
  if (!sim) return;
  try {
    const controller = controllerFactory();
    if (typeof controller !== 'function') throw new Error('createController 必须返回函数');
    sim.controller = controller; sim.reset(); setRunning(false); chart.history = []; lastSample = -1; syncControls(); updatePanel(); toast('已恢复初始位置与轮速');
  } catch (e) { setRunning(false); toast(`算法重置失败：${e.message}`, true); }
});
$('stop-motors').addEventListener('click', () => { if (!sim) return; setRunning(false); sim.stop(); sim.sample(); syncControls(); updatePanel(); toast('双轮已停止，目标轮速归零'); });
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); if (sim && !gesture) setRunning(!running); }
});
document.addEventListener('visibilitychange', () => { lastFrame = 0; accumulator = 0; if (document.hidden && sim) setRunning(false); });
for (const side of ['left', 'right']) $(`${side}-rpm`).addEventListener('input', () => {
  if (!sim || sim.mode !== 'manual') return;
  if ($('link-wheels').checked) $(`${side === 'left' ? 'right' : 'left'}-rpm`).value = $(`${side}-rpm`).value;
  sim.setCommand(Number($('left-rpm').value), Number($('right-rpm').value)); syncControls();
});
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (!sim) return;
  setRunning(false); sim.stop(); sim.mode = button.dataset.mode; sim.algorithmError = null;
  sim.controllerComplete = false; sim.controllerFailed = false; sim.controllerStatus = '';
  try { sim.controller = controllerFactory(); } catch (e) { toast(`算法初始化失败：${e.message}`, true); sim.mode = 'manual'; }
  sim.sample(); syncControls(); updatePanel();
}));
document.querySelectorAll('[data-imu]').forEach(button => button.addEventListener('click', () => {
  chart.selected = button.dataset.imu;
  document.querySelectorAll('[data-imu]').forEach(b => b.classList.toggle('active', b === button));
  $('chart-title').textContent = modeNames[chart.selected]; if (sim) chart.draw(sim);
}));

function canvasPoint(event) { const r = canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; }
canvas.addEventListener('pointerdown', event => {
  if (!sim || event.button !== 0 || gesture) return;
  const point = canvasPoint(event), world = renderer.screenToWorld(point.x, point.y), car = renderer.hitCar(point.x, point.y, sim.pose);
  if (!car) setFollowCar(false);
  gesture = { pointerId: event.pointerId, type: car ? 'car' : 'pan', start: point, camera: { ...renderer.camera }, dx: world.xMm - sim.pose.xMm, dy: world.yMm - sim.pose.yMm };
  if (car) { setRunning(false); sim.stop(); syncControls(); }
  canvas.setPointerCapture(event.pointerId); canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', event => {
  if (!sim) return;
  const point = canvasPoint(event);
  if (!gesture) { canvas.style.cursor = renderer.hitCar(point.x, point.y, sim.pose) ? 'move' : 'grab'; return; }
  if (gesture.pointerId !== event.pointerId) return;
  if (gesture.type === 'car') {
    const world = renderer.screenToWorld(point.x, point.y);
    sim.teleport({ xMm: world.xMm - gesture.dx, yMm: world.yMm - gesture.dy, headingRad: sim.pose.headingRad });
  } else {
    renderer.camera.x = gesture.camera.x + point.x - gesture.start.x; renderer.camera.y = gesture.camera.y + point.y - gesture.start.y;
  }
});
function releasePointer(event) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  gesture = null; canvas.classList.remove('dragging');
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
canvas.addEventListener('pointerup', releasePointer); canvas.addEventListener('pointercancel', releasePointer); canvas.addEventListener('lostpointercapture', releasePointer);
canvas.addEventListener('wheel', event => {
  if (!sim) return; event.preventDefault();
  const point = canvasPoint(event);
  if (gesture?.type === 'car') sim.teleport({ ...sim.pose, headingRad: sim.pose.headingRad + Math.sign(event.deltaY) * config.view.rotationStepDeg * Math.PI / 180 });
  else if (!gesture) {
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? renderer.height : 1);
    const anchor = renderer.followCar ? { x: renderer.width / 2, y: renderer.height / 2 } : point;
    renderer.zoomAt(anchor.x, anchor.y, Math.exp(-pixels * config.view.zoomSensitivity));
  }
}, { passive: false });
$('zoom-in').addEventListener('click', () => renderer?.zoomAt(renderer.width / 2, renderer.height / 2, 1.2));
$('zoom-out').addEventListener('click', () => renderer?.zoomAt(renderer.width / 2, renderer.height / 2, 1 / 1.2));
$('fit-view').addEventListener('click', () => { if (renderer) { setFollowCar(false); renderer.fit(); } });
$('locate-car').addEventListener('click', () => { if (renderer) renderer.locate(sim.pose); });
function setFollowCar(enabled) {
  if (!renderer) return;
  renderer.followCar = enabled;
  config.view.followCar = enabled;
  const button = $('follow-car');
  button.setAttribute('aria-pressed', String(enabled));
  button.title = enabled ? '关闭视角跟随' : '开启视角跟随';
  button.querySelector('span').textContent = enabled ? '跟随中' : '跟随';
  document.querySelector('[data-view="followCar"]').checked = enabled;
  if (enabled && !gesture) renderer.locate(sim.pose);
}
$('follow-car').addEventListener('click', () => { if (renderer) setFollowCar(!renderer.followCar); });

function switchTab(settings) {
  $('data-panel').hidden = settings; $('settings-panel').hidden = !settings;
  for (const [id, active] of [['tab-data', !settings], ['tab-settings', settings]]) { $(id).classList.toggle('active', active); $(id).setAttribute('aria-selected', String(active)); }
}
$('tab-data').addEventListener('click', () => switchTab(false)); $('tab-settings').addEventListener('click', () => switchTab(true));
// 数值控件由同一份校验字段表生成，避免配置与界面参数各自维护。
for (const group of [...new Set(numberFields.map(f => f[6]))]) {
  if (staticMode && group === '服务设置') continue;
  const section = document.createElement('section'); section.className = 'settings-group';
  const title = document.createElement('h3'); title.textContent = group; section.append(title);
  const grid = document.createElement('div'); grid.className = 'fields-grid';
  for (const [path, label, unit, min, max, step] of numberFields.filter(f => f[6] === group)) {
    const field = document.createElement('label'); field.className = 'field';
    const text = document.createElement('span'); text.textContent = label;
    const wrapper = document.createElement('div'); wrapper.className = 'input-with-unit';
    const input = document.createElement('input'); Object.assign(input, { type: 'number', min, max, step, required: true }); input.dataset.path = path; input.setAttribute('aria-label', label);
    const suffix = document.createElement('span'); suffix.textContent = unit;
    wrapper.append(input, suffix); field.append(text, wrapper); grid.append(field);
  }
  section.append(grid); $('config-fields').append(section);
}
function fillSettings(c) {
  draft = structuredClone(c); $('track-image').value = c.track.image; $('detect-mode').value = c.infrared.detect;
  $('track-select').value = [...$('track-select').options].some(option => option.value === c.track.image) ? c.track.image : '';
  syncTrackSelection();
  document.querySelectorAll('[data-path]').forEach(input => { input.value = getPath(c, input.dataset.path); });
  document.querySelectorAll('[data-view]').forEach(input => { input.checked = c.view[input.dataset.view]; });
}
function syncTrackSelection() {
  const selected = $('track-select').value;
  if (selected) $('track-image').value = selected;
  $('custom-track-field').hidden = Boolean(selected);
  $('track-image').disabled = Boolean(selected);
}
$('track-select').addEventListener('change', syncTrackSelection);
function collectSettings() {
  if (!$('settings-form').reportValidity()) throw new Error('请检查参数范围和必填项');
  const c = structuredClone(draft);
  document.querySelectorAll('[data-path]').forEach(input => setPath(c, input.dataset.path, Number(input.value)));
  document.querySelectorAll('[data-view]').forEach(input => { c.view[input.dataset.view] = input.checked; });
  c.track.image = $('track-image').value.trim(); c.infrared.detect = $('detect-mode').value;
  return validateConfig(c);
}
async function applySettings(save) {
  if (!sim) return;
  const buttons = [$('apply-config'), $('save-config')]; buttons.forEach(b => { b.disabled = true; });
  setRunning(false);
  try {
    const c = collectSettings(), assets = await prepare(c);
    if (save) await store.save(c);
    const serverChanged = c.server.port !== config.server.port || c.server.host !== config.server.host;
    install(c, assets);
    toast(save ? (staticMode ? '已保存到当前浏览器，并重置仿真' : `已保存到 config.json，并重置仿真${serverChanged ? '；服务端口将在重启后生效' : ''}`) : '参数已应用并重置仿真；尚未保存');
  } catch (e) { toast(e.message, true); }
  finally { buttons.forEach(b => { b.disabled = false; }); }
}
$('settings-form').addEventListener('submit', event => event.preventDefault());
$('apply-config').addEventListener('click', () => applySettings(false)); $('save-config').addEventListener('click', () => applySettings(true));
$('edit-json').addEventListener('click', () => { try { $('json-editor').value = JSON.stringify(collectSettings(), null, 2); $('json-error').textContent = ''; $('json-dialog').showModal(); } catch (e) { toast(e.message, true); } });
$('accept-json').addEventListener('click', () => {
  try { const c = validateConfig(JSON.parse($('json-editor').value)); fillSettings(c); $('json-dialog').close(); toast('配置已校验，请点击应用或保存'); }
  catch (e) { $('json-error').textContent = e.message; }
});
$('export-config').addEventListener('click', () => {
  try {
    const c = validateConfig(JSON.parse($('json-editor').value));
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(c, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'smartcar-config.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { $('json-error').textContent = e.message; }
});
$('import-config').addEventListener('click', () => $('config-file').click());
$('config-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 65536) throw new Error('配置不能超过 64 KB');
    const c = validateConfig(JSON.parse(await file.text()));
    $('json-editor').value = JSON.stringify(c, null, 2); $('json-error').textContent = '';
  } catch (e) { $('json-error').textContent = e.message; }
  finally { event.target.value = ''; }
});
$('restore-defaults').addEventListener('click', async () => {
  if (!sim) return;
  setRunning(false);
  try {
    const c = await store.defaults(), assets = await prepare(c);
    store.clear(); install(c, assets); toast('已恢复站点默认配置，并清除浏览器中的保存');
  } catch (e) { toast(e.message, true); }
});
if (staticMode) {
  $('save-config').lastChild.textContent = '保存到浏览器';
  $('settings-description').textContent = '调整后可应用，或保存到当前浏览器。完整 JSON 配置支持导入、导出；恢复默认可清除已保存的设置。';
  $('environment-label').textContent = '在线实验环境';
  $('restore-defaults').hidden = false;
}
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('.close-dialog').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } }));

async function boot() {
  try {
    const [loaded, tracks] = await Promise.all([store.load(), store.tracks()]);
    for (const track of tracks) {
      const option = document.createElement('option'); option.value = track; option.textContent = track;
      $('track-select').insertBefore(option, $('track-select').lastElementChild);
    }
    try { install(loaded.config, await prepare(loaded.config)); }
    catch (e) {
      if (!loaded.saved) throw e;
      install(loaded.defaults, await prepare(loaded.defaults));
      loaded.warning = `已保存的配置无法载入，已恢复站点默认值：${e.message}`;
    }
    if (loaded.warning) toast(loaded.warning, true);
  } catch (e) {
    $('loading').replaceChildren();
    const title = document.createElement('strong'); title.textContent = '实验环境载入失败';
    const description = document.createElement('span'); description.textContent = e.message; description.style.cssText = 'max-width:80%;text-align:center;line-height:1.8';
    const retry = document.createElement('button'); retry.className = 'button'; retry.textContent = '重新载入'; retry.addEventListener('click', () => location.reload());
    $('loading').append(title, description, retry);
  }
}
requestAnimationFrame(frame);
boot();
