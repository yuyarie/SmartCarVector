import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Simulator } from '../core/simulator.mjs';
import { createPixelSampler } from '../core/sensors.mjs';
import { createController } from '../public/algorithms/route-demo.js';
import { readPng } from './helpers/png.mjs';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const png = await readPng(new URL('../简单赛道.png', import.meta.url));
const sampler = createPixelSampler(png, config.track.widthMm, config.track.backgroundReflectance);
const corners = [[1150,1750],[1150,250],[2250,250],[2250,1750],[1600,1750],[1600,250],[250,250],[250,1750]];

function centeredLine(state, p) {
  const values = state.infrared.map(s => Math.max(0, (s.reflectance-p.darkReflectance)/(1-p.darkReflectance)));
  const total = values.reduce((a,b) => a+b, 0);
  const error = values.reduce((sum,v,i) => sum+v*(i-2), 0) / total;
  const broad = [0,1,2].some(i => values.slice(i,i+3).every(v => v>p.lineThreshold));
  return values[2]>p.lineThreshold && Math.abs(error)<p.centerTolerance && !broad;
}

function replay(c, scale = 1) {
  const controller = createController(), visited = [], durations = [];
  let lastOutput, lastSampleTime, centeredSamples = 0, turnStart;
  const pixelSampler = createPixelSampler(png, c.track.widthMm, c.track.backgroundReflectance);
  const sim = new Simulator(c, pixelSampler, (state, dt, p) => {
    const centered = centeredLine(state, p);
    if (state.sampleTime !== lastSampleTime) {
      centeredSamples = lastOutput?.telemetry.phase === 'turn' && centered ? centeredSamples+1 : 0;
      lastSampleTime = state.sampleTime;
    }
    const output = controller(state, dt, p);
    if (output.telemetry.phase === 'turn' && lastOutput?.telemetry.phase !== 'turn') turnStart = state.time;
    if (output.status.startsWith('红外确认出弯')) {
      assert.ok(centered, '出弯必须有居中的目标线信号');
      assert.ok(centeredSamples >= p.confirmSamples, '重复读取同一次采样不能充当连续确认');
      durations.push(state.time-turnStart);
      visited.push({ ...sim.pose });
    }
    lastOutput = output;
    return output;
  });
  for (let i = 0; i < c.simulation.fixedStepHz*180; i++) {
    sim.step(1/c.simulation.fixedStepHz);
    assert.equal(sim.algorithmError, null);
    if (sim.controllerComplete || sim.controllerFailed) break;
  }
  assert.ok(sim.controllerComplete, sim.controllerStatus);
  assert.equal(visited.length, 8, '只在确认目标线后推进路线');
  corners.forEach(([x,y], i) => assert.ok(Math.hypot(visited[i].xMm-x*scale, visited[i].yMm-y*scale) < 60*scale,
    `转角 ${i+1} 未到达实际路口`));
  const finishError = Math.hypot(sim.pose.xMm-c.vehicle.initialPose.xMm, sim.pose.yMm-c.vehicle.initialPose.yMm);
  assert.ok(finishError < 45, `停车偏差 ${finishError.toFixed(1)} mm`);
  assert.equal(sim.wheels.leftRpm, 0); assert.equal(sim.wheels.rightRpm, 0);
  return { time: sim.time, durations, finishError };
}

test('受限输入只允许 5 路反射率和六轴惯导，不泄露坐标、轮速或地磁', () => {
  const sim = new Simulator(structuredClone(config), sampler, createController());
  const input = sim.snapshot();
  assert.deepEqual(Object.keys(input).sort(), ['imu', 'infrared', 'sampleTime', 'time']);
  assert.deepEqual(Object.keys(input.imu).sort(), ['accelerometer', 'gyroscope']);
  assert.equal(input.infrared.length, 5);
  assert.deepEqual(Object.keys(input.infrared[0]).sort(), ['detected', 'index', 'reflectance']);
  input.imu.gyroscope.z = 10000;
  assert.notEqual(sim.imu.gyroscope.z, 10000);
});

test('真实 PNG：高噪声、歪车和横向偏移的 65 个场景均按红外事件完成 8 次转弯', () => {
  const results = [];
  const starts = [[0,0],[-15,0],[15,0],[-25,0],[25,0],[-10,10],[10,-10],[0,15],[0,-15],[-25,15],[25,-15],[-25,-15],[25,15]];
  for (const seed of [1,7,42,2026,65535]) for (const [angle,offsetY] of starts) {
    const c = structuredClone(config);
    c.simulation.randomSeed = seed;
    c.imu.accelerometerNoiseStd = .02; c.imu.gyroscopeNoiseStd = .02;
    c.vehicle.initialPose.headingDeg = angle; c.vehicle.initialPose.yMm += offsetY;
    try { results.push(replay(c)); }
    catch (error) { error.message = `seed=${seed}, angle=${angle}, offsetY=${offsetY}: ${error.message}`; throw error; }
  }
  assert.ok(results.every(r => r.time<85), '不能靠延长盲走/搜线时间掩盖控制不稳定');
  const durations = results.flatMap(r => r.durations);
  assert.ok(Math.max(...durations)<2, '确认的正常转弯应快速完成');
  console.log(`65 场景完赛：${Math.min(...results.map(r=>r.time)).toFixed(2)}～${Math.max(...results.map(r=>r.time)).toFixed(2)} s；转向 ${Math.min(...durations).toFixed(2)}～${Math.max(...durations).toFixed(2)} s；最大停车偏差 ${Math.max(...results.map(r=>r.finishError)).toFixed(1)} mm`);
});

test('改变发车纵向位置和赛道物理比例，不靠固定路段距离触发转弯', () => {
  for (const [offsetX,angle] of [[100,10],[-100,-10]]) {
    const c = structuredClone(config);
    c.vehicle.initialPose.xMm += offsetX; c.vehicle.initialPose.headingDeg = angle;
    replay(c);
  }
  for (const scale of [.8,1.2]) {
    const c = structuredClone(config);
    c.track.widthMm *= scale; c.vehicle.initialPose.xMm *= scale; c.vehicle.initialPose.yMm *= scale;
    // 车体、模组、轮径和算法参数均不按赛道缩放。
    replay(c, scale);
  }
});

test('转向期间红外失效：即使陀螺仪已转过 90°，也不能确认出弯或推进路线', () => {
  const c = structuredClone(config), controller = createController();
  let drop = false, baseYaw = 0, maxAngle = 0, output;
  const sim = new Simulator(c, sampler, (state, dt, p) => {
    if (drop) state.infrared = state.infrared.map(s=>({...s,reflectance:p.darkReflectance,detected:false}));
    output = controller(state, dt, p);
    if (!drop && output.telemetry.phase === 'turn') { drop = true; baseYaw = output.telemetry.yaw; }
    if (drop) {
      maxAngle = Math.max(maxAngle, Math.abs(output.telemetry.yaw-baseYaw));
      assert.equal(output.telemetry.leg, 0);
      assert.equal(output.telemetry.turnConfirmations, 0);
      assert.equal(output.complete, false);
    }
    return output;
  });
  for (let i=0;i<c.simulation.fixedStepHz*60 && !sim.controllerFailed;i++) sim.step(1/c.simulation.fixedStepHz);
  assert.equal(sim.algorithmError, null);
  assert.ok(drop); assert.ok(maxAngle>Math.PI/2, '测试必须实际经历超过 90° 的陀螺仪转角');
  assert.ok(sim.controllerFailed, '持续失去目标线必须安全停止');
  assert.equal(sim.wheels.leftRpm, 0); assert.equal(sim.wheels.rightRpm, 0);
});

test('演示拒绝通道数量错误，并在起步无法找到线时安全停车', () => {
  const wrong = structuredClone(config); wrong.infrared.count = 8;
  const invalid = new Simulator(wrong, sampler, createController()); invalid.step(1/120);
  assert.match(invalid.algorithmError, /5 路红外/);
  const sim = new Simulator(structuredClone(config), () => .13, createController());
  for (let i=0;i<120*30 && !sim.controllerFailed;i++) sim.step(1/120);
  assert.ok(sim.controllerFailed); assert.equal(sim.controllerComplete, false);
  assert.equal(sim.wheels.leftRpm, 0); assert.equal(sim.wheels.rightRpm, 0);
});
