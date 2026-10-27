import { clamp, createRandom, normalizeAngle, readInfrared, readImu } from './sensors.mjs';

export class Simulator {
  constructor(config, sampler, controller = () => ({ leftRpm: 0, rightRpm: 0 })) {
    this.config = config;
    this.sampler = sampler;
    this.controller = controller;
    this.reset();
  }
  reset() {
    const c = this.config, p = c.vehicle.initialPose;
    this.pose = { xMm: p.xMm, yMm: p.yMm, headingRad: p.headingDeg * Math.PI / 180 };
    this.random = createRandom(c.simulation.randomSeed);
    this.time = 0; this.sensorElapsed = 0; this.sampleId = 0;
    this.motion = { speedMps: 0, angularVelocityRadSec: 0, accelerationMps2: 0 };
    this.wheels = { leftRpm: 0, rightRpm: 0, leftAngleRad: 0, rightAngleRad: 0 };
    this.command = { leftRpm: c.control.leftRpm, rightRpm: c.control.rightRpm };
    this.mode = c.control.mode;
    this.trail = []; this.algorithmError = null; this.controllerStatus = ''; this.controllerComplete = false; this.controllerFailed = false;
    this.sample();
  }
  get wheelbaseMm() { return this.config.vehicle.widthMm + this.config.wheels.widthMm + 2 * this.config.wheels.gapMm; }
  setCommand(leftRpm, rightRpm) {
    const max = this.config.wheels.maxRpm;
    this.command = { leftRpm: clamp(Number.isFinite(leftRpm) ? leftRpm : 0, -max, max), rightRpm: clamp(Number.isFinite(rightRpm) ? rightRpm : 0, -max, max) };
  }
  stop() { this.setCommand(0, 0); this.wheels.leftRpm = 0; this.wheels.rightRpm = 0; this.motion = { speedMps: 0, angularVelocityRadSec: 0, accelerationMps2: 0 }; }
  teleport(pose) {
    this.pose = { ...pose, headingRad: normalizeAngle(pose.headingRad) };
    this.stop();
    this.sample(); // 拖动属于重新放置，不产生虚假的巨大惯性加速度。
  }
  snapshot() {
    if (this.config.algorithm.inputProfile === 'ir5-imu6') {
      if (this.infrared.length !== 5) throw new Error('受限控制器要求 5 路红外');
      return structuredClone({
        time: this.time, sampleTime: this.sampleTime,
        infrared: this.infrared.map(({ index, reflectance, detected }) => ({ index, reflectance, detected })),
        imu: { accelerometer: this.imu.accelerometer, gyroscope: this.imu.gyroscope }
      });
    }
    return structuredClone({ time: this.time, pose: this.pose, motion: this.motion, wheels: this.wheels, infrared: this.infrared, imu: this.imu });
  }
  sample() {
    this.infrared = readInfrared(this.config, this.pose, this.sampler, this.random);
    this.imu = readImu(this.config, this.pose, this.motion, this.random);
    this.sampleTime = this.time;
    this.sampleId++;
  }
  step(dt) {
    const c = this.config;
    if (this.mode === 'algorithm') {
      try {
        const output = this.controller(this.snapshot(), dt, structuredClone(c.algorithm.parameters));
        if (!output || !Number.isFinite(output.leftRpm) || !Number.isFinite(output.rightRpm)) throw new Error('算法需同步返回有限数值 leftRpm 和 rightRpm');
        this.setCommand(output.leftRpm, output.rightRpm);
        this.controllerStatus = typeof output.status === 'string' ? output.status : '';
        this.controllerComplete = output.complete === true;
        this.controllerFailed = output.failed === true;
        if (this.controllerComplete || this.controllerFailed) { this.stop(); this.sample(); return; }
      } catch (error) {
        this.algorithmError = error.message; this.stop(); return;
      }
    }
    const response = c.wheels.responseTimeSec === 0 ? 1 : 1 - Math.exp(-dt / c.wheels.responseTimeSec);
    for (const side of ['left', 'right']) {
      this.wheels[`${side}Rpm`] += (this.command[`${side}Rpm`] - this.wheels[`${side}Rpm`]) * response;
      this.wheels[`${side}AngleRad`] = normalizeAngle(this.wheels[`${side}AngleRad`] + this.wheels[`${side}Rpm`] * Math.PI / 30 * dt);
    }
    const left = this.wheels.leftRpm * Math.PI * c.wheels.diameterMm / 60;
    const right = this.wheels.rightRpm * Math.PI * c.wheels.diameterMm / 60;
    const speed = (left + right) / 2;
    // 屏幕坐标 Y 向下，左轮更快时顺时针旋转。
    const omega = (left - right) / this.wheelbaseMm;
    const angle = this.pose.headingRad, delta = omega * dt;
    if (Math.abs(omega) < 1e-9) {
      this.pose.xMm += speed * Math.cos(angle) * dt;
      this.pose.yMm += speed * Math.sin(angle) * dt;
    } else {
      this.pose.xMm += speed / omega * (Math.sin(angle + delta) - Math.sin(angle));
      this.pose.yMm -= speed / omega * (Math.cos(angle + delta) - Math.cos(angle));
    }
    this.pose.headingRad = normalizeAngle(angle + delta);
    this.motion = { speedMps: speed / 1000, angularVelocityRadSec: omega, accelerationMps2: (speed / 1000 - this.motion.speedMps) / dt };
    this.time += dt; this.sensorElapsed += dt;
    if (this.sensorElapsed + 1e-10 >= 1 / c.simulation.sensorHz) {
      this.sensorElapsed %= 1 / c.simulation.sensorHz;
      this.sample();
      const prev = this.trail.at(-1);
      if (!prev || Math.hypot(prev.xMm - this.pose.xMm, prev.yMm - this.pose.yMm) > 2) {
        this.trail.push({ ...this.pose });
        if (this.trail.length > c.simulation.trailLimit) this.trail.shift();
      }
    }
  }
}
