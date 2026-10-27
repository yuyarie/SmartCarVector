/**
 * 寻路算法预留接口（同步调用，每个固定物理步一次）。默认输出零速。
 * 在这里替换策略，或在 config.json 的 algorithm.module 指向新模块。
 *
 * state: { time, pose: {xMm,yMm,headingRad}, motion, wheels, infrared, imu }
 * infrared: [{index,xMm,yMm,lateralMm,reflectance:0..1,detected:boolean}]
 * imu: { accelerometer:{x,y,z}, gyroscope:{x,y,z}, magnetometer:{x,y,z} }
 * 单位：位置 mm；加速度 m/s²；角速度 rad/s；磁场 μT。
 * 世界系 X 向右 / Y 向下；车体系 X 向前 / Y 向右；正航向顺时针。
 * dt: 秒；parameters: config.json 中的 algorithm.parameters。
 * 返回 {leftRpm,rightRpm}，有符号 RPM；框架自动限制到 wheels.maxRpm。
 * 启用算法模式后点开始；编辑模块后刷新页面即可载入新代码。
 */
export function createController() {
  // 可在此声明 PID 积分、上次偏差等算法私有状态。重置仿真会重新创建实例。
  return function update(state, dt, parameters) {
    void state; void dt; void parameters;
    return { leftRpm: 0, rightRpm: 0 };
  };
}
