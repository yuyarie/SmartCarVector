import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Simulator } from '../core/simulator.mjs';
import { createPixelSampler, sensorPositions } from '../core/sensors.mjs';
import { validateConfig } from '../core/config.mjs';

const original = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
function setup() {
  const c = structuredClone(original);
  c.wheels.responseTimeSec = 0; c.infrared.noiseStd = 0;
  c.imu.accelerometerNoiseStd = 0; c.imu.gyroscopeNoiseStd = 0; c.imu.magnetometerNoiseStd = 0;
  c.vehicle.initialPose = { xMm: 0, yMm: 0, headingDeg: 0 }; c.control.mode = 'manual';
  c.algorithm.inputProfile = 'full';
  return c;
}
const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);

test('等速直行的位移与轮径吻合，并随固定步长一致', () => {
  for (const hz of [60, 120, 240]) {
    const c = setup(), sim = new Simulator(c, () => 0);
    sim.setCommand(60, 60);
    for (let i = 0; i < hz; i++) sim.step(1 / hz);
    close(sim.pose.xMm, Math.PI * c.wheels.diameterMm); close(sim.pose.yMm, 0); close(sim.pose.headingRad, 0);
    close(sim.time, 1); close(sim.motion.speedMps, Math.PI * c.wheels.diameterMm / 1000);
  }
});
test('反向等速双轮原地顺时针转动，轮距包含轮子宽度与间隙', () => {
  const c = setup(), sim = new Simulator(c, () => 0);
  sim.setCommand(60, -60); sim.step(.1);
  close(sim.pose.xMm, 0); close(sim.pose.yMm, 0);
  close(sim.pose.headingRad, 2 * Math.PI * c.wheels.diameterMm / (c.vehicle.widthMm + c.wheels.widthMm + 2 * c.wheels.gapMm) * .1);
  assert.ok(sim.imu.gyroscope.z > 0);
});
test('单轮圆弧运动符合解析解，正反运动均保留符号', () => {
  const c = setup(), sim = new Simulator(c, () => 0);
  sim.setCommand(60, 0); sim.step(.2);
  const angle = sim.pose.headingRad, radius = sim.wheelbaseMm / 2;
  close(sim.pose.xMm, radius * Math.sin(angle)); close(sim.pose.yMm, radius * (1 - Math.cos(angle)));
  assert.ok(sim.imu.accelerometer.y > 0);
  sim.reset(); sim.setCommand(-60, -60); sim.step(.1); assert.ok(sim.pose.xMm < 0);
});
test('电机一阶响应与最大转速限幅', () => {
  const c = setup(); c.wheels.responseTimeSec = .2;
  const sim = new Simulator(c, () => 0); sim.setCommand(1e6, -1e6); sim.step(.2);
  close(sim.wheels.leftRpm, c.wheels.maxRpm * (1 - Math.exp(-1)));
  close(sim.wheels.rightRpm, -sim.wheels.leftRpm);
});
test('1 / 8 / 64 路均分布局、模组净间距与旋转变换', () => {
  for (const n of [1, 8, 64]) {
    const c = setup(); c.infrared.count = n;
    const p = sensorPositions(c, { xMm: 10, yMm: 20, headingRad: Math.PI / 2 });
    assert.equal(p.length, n);
    const forward = c.vehicle.lengthMm / 2 + c.infrared.gapMm + c.infrared.depthMm / 2;
    close(p[0].yMm, 20 + forward);
    close(p.reduce((sum, s) => sum + s.lateralMm, 0), 0);
    if (n > 1) close(p[1].lateralMm - p[0].lateralMm, c.infrared.widthMm / n);
    else close(p[0].xMm, 10);
  }
});
test('像素反射率、透明度、边界与亮/暗线阈值', () => {
  const sample = createPixelSampler({ width: 2, height: 1, data: Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]) }, 200, .03);
  close(sample(25, 25), 1); close(sample(150, 25), 0); close(sample(-1, 0), .03); close(sample(200, 0), .03);
  const transparent = createPixelSampler({ width: 1, height: 1, data: [255, 255, 255, 0] }, 100, .2); close(transparent(0, 0), .2);
  const c = setup(), sim = new Simulator(c, () => .8); assert.ok(sim.infrared.every(s => s.detected));
  c.infrared.detect = 'dark'; sim.sample(); assert.ok(sim.infrared.every(s => !s.detected));
});
test('九轴输出：重力、航向旋转磁场、平面非活动轴', () => {
  const c = setup(); c.vehicle.initialPose.headingDeg = 90;
  const sim = new Simulator(c, () => 0), { accelerometer: a, gyroscope: g, magnetometer: m } = sim.imu;
  close(a.x, 0); close(a.y, 0); close(a.z, c.imu.gravity); close(g.x, 0); close(g.y, 0); close(g.z, 0);
  close(m.x, c.imu.magneticFieldUT.y); close(m.y, -c.imu.magneticFieldUT.x); close(m.z, c.imu.magneticFieldUT.z);
});
test('固定随机种子可复现噪声，重新放置不会引入虚假的惯性冲击', () => {
  const c = structuredClone(original), a = new Simulator(c, () => .5), b = new Simulator(c, () => .5);
  assert.deepEqual(a.imu, b.imu); assert.deepEqual(a.infrared, b.infrared);
  a.setCommand(60, 60); a.step(.1); a.teleport({ xMm: 5000, yMm: 5000, headingRad: 0 });
  close(a.motion.accelerationMps2, 0); close(a.wheels.leftRpm, 0); close(a.command.leftRpm, 0);
});
test('算法快照隔离；非法输出/异常安全停机；空接口静止', () => {
  const c = setup(); c.control.mode = 'algorithm';
  const sim = new Simulator(c, () => 0, (s, dt, p) => { s.pose.xMm = 1e9; p.test = true; assert.ok(dt > 0); return { leftRpm: 0, rightRpm: 0 }; });
  sim.step(.1); close(sim.pose.xMm, 0); assert.equal(c.algorithm.parameters.test, undefined);
  sim.controller = () => ({ leftRpm: NaN, rightRpm: 60 }); sim.step(.1);
  assert.ok(sim.algorithmError); close(sim.wheels.leftRpm, 0); close(sim.wheels.rightRpm, 0);
  sim.controller = () => { throw new Error('策略错误'); }; sim.step(.1); assert.equal(sim.algorithmError, '策略错误');
});
test('配置拒绝零轮径、无效数量、过高采样率和越界路径', () => {
  validateConfig(original);
  for (const mutate of [c => c.wheels.diameterMm = 0, c => c.infrared.count = 1.5, c => c.simulation.sensorHz = 240, c => c.track.image = '../secret.png', c => c.view.showGrid = 'yes', c => c.algorithm.module = '/algorithms/../app.js']) {
    const c = structuredClone(original); mutate(c); assert.throws(() => validateConfig(c));
  }
});
