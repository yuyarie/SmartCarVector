import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Simulator } from '../core/simulator.mjs';
import { createPixelSampler } from '../core/sensors.mjs';
import { createController } from '../public/algorithms/route-demo.js';
import { readPng } from '../test/helpers/png.mjs';

const c = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const png = await readPng(new URL(`../${c.track.image}`, import.meta.url));
const controller = createController(), turns = [];
let output, previousPhase, turnStart;
const sim = new Simulator(c, createPixelSampler(png, c.track.widthMm, c.track.backgroundReflectance), (state, dt, parameters) => {
  output = controller(state, dt, parameters);
  if (output.telemetry.phase === 'turn' && previousPhase !== 'turn') turnStart = state.time;
  if (output.status.startsWith('红外确认出弯')) turns.push({
    time: state.time, durationSec: state.time-turnStart, ...sim.pose,
    infrared: state.infrared.map(s=>s.reflectance), centered: output.telemetry.lineCentered
  });
  previousPhase = output.telemetry.phase;
  return output;
});
const trace = [], events = [];
let previous;
for (let n = 0; n < c.simulation.fixedStepHz * (c.algorithm.parameters.timeoutSec + 1); n++) {
  sim.step(1 / c.simulation.fixedStepHz);
  if (n % 12 === 0) trace.push({ ...sim.pose });
  if (previous !== sim.controllerStatus) {
    previous = sim.controllerStatus;
    const event = { time: +sim.time.toFixed(2), status: previous, x: +sim.pose.xMm.toFixed(1), y: +sim.pose.yMm.toFixed(1), heading: +(sim.pose.headingRad * 180 / Math.PI).toFixed(1) };
    events.push(event); console.log(event);
  }
  if (sim.algorithmError || sim.controllerComplete || sim.controllerStatus.startsWith('安全停止')) break;
}
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
const image = (await readFile(new URL(`../${c.track.image}`, import.meta.url))).toString('base64');
const height = c.track.widthMm * png.height / png.width;
await writeFile(new URL('../test-results/route-trace.svg', import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.track.widthMm} ${height}"><image href="data:image/png;base64,${image}" width="${c.track.widthMm}" height="${height}"/><polyline points="${trace.map(p => `${p.xMm},${p.yMm}`).join(' ')}" fill="none" stroke="#ff7043" stroke-width="8"/><circle cx="${sim.pose.xMm}" cy="${sim.pose.yMm}" r="15" fill="#76ffbc"/></svg>`);
await writeFile(new URL('../test-results/route-report.json', import.meta.url), JSON.stringify({ complete: sim.controllerComplete, error: sim.algorithmError, time: sim.time, finalPose: sim.pose, turns, events }, null, 2));
console.log(`完赛=${sim.controllerComplete}，时间=${sim.time.toFixed(2)}s，红外确认转弯=${turns.length} 次，转向耗时=${turns.map(t=>t.durationSec.toFixed(2)).join(' / ')}s`);
if (!sim.controllerComplete) process.exitCode = 1;
