// 所有用户参数的初始值只在根目录 config.json 中定义。
export const numberFields = [
  ['vehicle.lengthMm', '车身长度', 'mm', 20, 1000, 1, '车体与双轮'],
  ['vehicle.widthMm', '车身宽度', 'mm', 20, 1000, 1, '车体与双轮'],
  ['wheels.diameterMm', '轮子直径', 'mm', 5, 500, 1, '车体与双轮'],
  ['wheels.widthMm', '轮子宽度', 'mm', 2, 100, 1, '车体与双轮'],
  ['wheels.gapMm', '轮子 / 车身间距', 'mm', 0, 100, 1, '车体与双轮'],
  ['wheels.maxRpm', '最大轮速', 'RPM', 1, 2000, 1, '车体与双轮'],
  ['wheels.responseTimeSec', '电机响应时间', 's', 0, 5, 0.01, '车体与双轮'],
  ['infrared.count', '传感器数量', '路', 1, 64, 1, '红外模组'],
  ['infrared.widthMm', '模组宽度', 'mm', 5, 1000, 1, '红外模组'],
  ['infrared.depthMm', '模组厚度', 'mm', 2, 100, 1, '红外模组'],
  ['infrared.gapMm', '模组 / 车头净间距', 'mm', 0, 500, 1, '红外模组'],
  ['infrared.sampleRadiusMm', '采样半径', 'mm', 0, 30, 0.5, '红外模组'],
  ['infrared.threshold', '触发阈值', '', 0, 1, 0.01, '红外模组'],
  ['infrared.noiseStd', '反射值噪声 σ', '', 0, 0.5, 0.001, '红外模组'],
  ['track.widthMm', '赛道图片物理宽度', 'mm', 100, 100000, 10, '赛道与初始位置'],
  ['track.backgroundReflectance', '图片外反射率', '', 0, 1, 0.01, '赛道与初始位置'],
  ['vehicle.initialPose.xMm', '初始 X', 'mm', -100000, 100000, 1, '赛道与初始位置'],
  ['vehicle.initialPose.yMm', '初始 Y', 'mm', -100000, 100000, 1, '赛道与初始位置'],
  ['vehicle.initialPose.headingDeg', '初始航向', '°', -360, 360, 1, '赛道与初始位置'],
  ['imu.gravity', '重力加速度', 'm/s²', 0, 30, 0.00001, '惯性测量'],
  ['imu.accelerometerNoiseStd', '加速度噪声 σ', 'm/s²', 0, 10, 0.001, '惯性测量'],
  ['imu.gyroscopeNoiseStd', '角速度噪声 σ', 'rad/s', 0, 10, 0.001, '惯性测量'],
  ['imu.magnetometerNoiseStd', '磁场噪声 σ', 'μT', 0, 100, 0.01, '惯性测量'],
  ['imu.magneticFieldUT.x', '世界磁场 X', 'μT', -200, 200, 1, '惯性测量'],
  ['imu.magneticFieldUT.y', '世界磁场 Y', 'μT', -200, 200, 1, '惯性测量'],
  ['imu.magneticFieldUT.z', '世界磁场 Z', 'μT', -200, 200, 1, '惯性测量'],
  ['simulation.fixedStepHz', '物理更新频率', 'Hz', 30, 500, 1, '仿真与显示'],
  ['simulation.sensorHz', '传感器采样频率', 'Hz', 1, 240, 1, '仿真与显示'],
  ['simulation.timeScale', '仿真倍率', '×', 0.1, 32, 0.1, '仿真与显示'],
  ['simulation.maxFrameDeltaSec', '最大帧时间', 's', 0.01, 0.5, 0.01, '仿真与显示'],
  ['simulation.randomSeed', '随机种子', '', 1, 4294967295, 1, '仿真与显示'],
  ['simulation.trailLimit', '轨迹点上限', '', 10, 20000, 1, '仿真与显示'],
  ['view.gridMm', '网格间距', 'mm', 10, 1000, 10, '仿真与显示'],
  ['view.historySeconds', '曲线历史长度', 's', 1, 120, 1, '仿真与显示'],
  ['view.rotationStepDeg', '每格滚轮旋转', '°', 1, 45, 1, '仿真与显示'],
  ['view.minZoom', '最小缩放', '×', 0.005, 1, 0.005, '仿真与显示'],
  ['view.maxZoom', '最大缩放', '×', 1, 20, 0.5, '仿真与显示'],
  ['view.zoomSensitivity', '缩放灵敏度', '', 0.0001, 0.02, 0.0001, '仿真与显示'],
  ['view.fitPaddingPx', '适应画布留白', 'px', 0, 400, 1, '仿真与显示'],
  ['view.uiHz', '面板刷新率', 'Hz', 1, 60, 1, '仿真与显示'],
  ['server.port', '服务端口（重启生效）', '', 1024, 65535, 1, '服务设置']
];
export const getPath = (obj, path) => path.split('.').reduce((v, key) => v?.[key], obj);
export function setPath(obj, path, value) {
  const parts = path.split('.');
  const key = parts.pop();
  parts.reduce((v, part) => v[part], obj)[key] = value;
}
export function validateConfig(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('配置必须是 JSON 对象');
  for (const [path, label, , min, max, step] of numberFields) {
    const n = getPath(c, path);
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (step === 1 && !Number.isInteger(n))) {
      throw new Error(`${label}需为 ${min} ~ ${max} 内的${step === 1 ? '整数' : '数值'} (${path})`);
    }
  }
  if (c.simulation.sensorHz > c.simulation.fixedStepHz) throw new Error('传感器采样频率不能超过物理更新频率');
  if (c.simulation.speedOptions !== undefined && (!Array.isArray(c.simulation.speedOptions) || c.simulation.speedOptions.length < 1 || c.simulation.speedOptions.length > 16 || c.simulation.speedOptions.some(value => !Number.isFinite(value) || value < 0.1 || value > 32))) throw new Error('速度选项需为 1～16 个 0.1～32 之间的倍率');
  if (c.view.minZoom >= c.view.maxZoom) throw new Error('最小缩放必须小于最大缩放');
  if (!['manual', 'algorithm'].includes(c.control?.mode)) throw new Error('控制模式必须为 manual 或 algorithm');
  for (const side of ['leftRpm', 'rightRpm']) {
    if (!Number.isFinite(c.control[side]) || Math.abs(c.control[side]) > c.wheels.maxRpm) throw new Error('初始轮速超出最大轮速');
  }
  if (!['bright', 'dark'].includes(c.infrared.detect)) throw new Error('红外检测模式需为 bright 或 dark');
  for (const key of ['showGrid', 'showTrail', 'showSensorFootprints']) {
    if (typeof c.view[key] !== 'boolean') throw new Error(`view.${key} 必须为布尔值`);
  }
  if (c.view.followCar !== undefined && typeof c.view.followCar !== 'boolean') throw new Error('view.followCar 必须为布尔值');
  if (!['127.0.0.1', 'localhost', '::1'].includes(c.server.host)) throw new Error('本地实验室仅支持回环地址');
  if (typeof c.track.image !== 'string' || !c.track.image || /(^[\\/]|:|(^|[\\/])\.\.([\\/]|$))/.test(c.track.image) || !/\.(png|jpe?g|webp|svg)$/i.test(c.track.image)) throw new Error('赛道图片需为项目内的 PNG/JPG/WebP/SVG 相对路径');
  if (typeof c.algorithm?.module !== 'string' || !/^\/algorithms\/[\w/.-]+\.js$/.test(c.algorithm.module) || c.algorithm.module.includes('..')) throw new Error('算法模块必须位于 /algorithms/ 中');
  if (!c.algorithm.parameters || typeof c.algorithm.parameters !== 'object' || Array.isArray(c.algorithm.parameters)) throw new Error('算法 parameters 必须为对象');
  if (c.algorithm.inputProfile !== undefined && !['full', 'ir5-imu6'].includes(c.algorithm.inputProfile)) throw new Error('不支持的算法输入配置');
  if (c.algorithm.inputProfile === 'ir5-imu6' && c.infrared.count !== 5) throw new Error('5 路红外 + 六轴惯导演示要求传感器数量为 5');
  return c;
}
