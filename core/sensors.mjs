export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const normalizeAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}
export function gaussian(random, std) {
  return std ? Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()) * std : 0;
}
export function sensorPositions(config, pose) {
  const { vehicle, infrared: ir } = config;
  // 模组净间距从车身前缘到模组后缘；通道中心落在等分单元中心。
  const forward = vehicle.lengthMm / 2 + ir.gapMm + ir.depthMm / 2;
  return Array.from({ length: ir.count }, (_, index) => {
    const lateral = ((index + 0.5) / ir.count - 0.5) * ir.widthMm;
    return {
      index, lateralMm: lateral,
      xMm: pose.xMm + Math.cos(pose.headingRad) * forward - Math.sin(pose.headingRad) * lateral,
      yMm: pose.yMm + Math.sin(pose.headingRad) * forward + Math.cos(pose.headingRad) * lateral
    };
  });
}
export function readInfrared(config, pose, sampler, random) {
  const ir = config.infrared;
  return sensorPositions(config, pose).map(p => {
    const raw = sampler(p.xMm, p.yMm, ir.sampleRadiusMm);
    const reflectance = clamp(raw + gaussian(random, ir.noiseStd), 0, 1);
    return { ...p, reflectance, detected: ir.detect === 'bright' ? reflectance >= ir.threshold : reflectance <= ir.threshold };
  });
}
export function readImu(config, pose, motion, random) {
  const c = config.imu;
  const noise = (v, std) => v + gaussian(random, std);
  const cos = Math.cos(pose.headingRad), sin = Math.sin(pose.headingRad);
  const b = c.magneticFieldUT;
  return {
    accelerometer: {
      x: noise(motion.accelerationMps2, c.accelerometerNoiseStd),
      y: noise(motion.speedMps * motion.angularVelocityRadSec, c.accelerometerNoiseStd),
      z: noise(c.gravity, c.accelerometerNoiseStd)
    },
    gyroscope: { x: noise(0, c.gyroscopeNoiseStd), y: noise(0, c.gyroscopeNoiseStd), z: noise(motion.angularVelocityRadSec, c.gyroscopeNoiseStd) },
    magnetometer: { x: noise(b.x * cos + b.y * sin, c.magnetometerNoiseStd), y: noise(-b.x * sin + b.y * cos, c.magnetometerNoiseStd), z: noise(b.z, c.magnetometerNoiseStd) }
  };
}
// CPU 像素采样，图片只在载入时读一次；越界使用配置反射率。
export function createPixelSampler({ data, width, height }, widthMm, outside) {
  const scale = width / widthMm;
  return (xMm, yMm, radiusMm = 0) => {
    let sum = 0;
    const offsets = radiusMm > 0 ? [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-0.707, -0.707], [0.707, -0.707], [-0.707, 0.707], [0.707, 0.707]] : [[0, 0]];
    for (const [dx, dy] of offsets) {
      const x = Math.floor((xMm + dx * radiusMm) * scale), y = Math.floor((yMm + dy * radiusMm) * scale);
      if (x < 0 || y < 0 || x >= width || y >= height) { sum += outside; continue; }
      const i = (y * width + x) * 4, alpha = data[i + 3] / 255;
      sum += ((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255) * alpha + outside * (1 - alpha);
    }
    return sum / offsets.length;
  };
}
