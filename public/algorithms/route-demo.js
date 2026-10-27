/**
 * 5 路红外 + 六轴 IMU：按红外路口事件执行路线，不按固定路段长度转弯。
 * 红外负责循线、横线/丢线检测和出弯确认；惯导辅助判向和抑制转动惯性。
 * 指令模型只用于把前置模组移到轮轴、短距断线和最终相对起点停车。
 */
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const rad = deg => deg * Math.PI / 180;
export function createController() {
  let phase = 'calibrate', age = 0, phaseAge = 0, leg = 0;
  let yaw = 0, bias = 0, biasSum = 0, biasSamples = 0, sampleTime = null;
  let left = 0, right = 0, previousLeft = 0, previousRight = 0;
  let distance = 0, x = 0, y = 0, legStart = 0;
  let lineYaw = 0, turnBaseYaw = 0, initialLineYaw = null;
  let lastSeen = 0, anchor = 0, rearmAt = 0, bridgeUntil = 0;
  let previousBroad = false, confirmSamples = 0, lineStable = 0, acquired = false;
  let sweepTarget = -1, failure = '', turnConfirmations = 0;
  const setPhase = next => { phase = next; phaseAge = 0; confirmSamples = 0; };
  return function update(state, dt, p) {
    if (state.infrared.length !== 5) throw new Error('路线演示必须使用 5 路红外');
    if (!p.route?.length || !p.drive) throw new Error('缺少路线拓扑或车体标定');
    age += dt; phaseAge += dt;
    const fresh = sampleTime !== state.sampleTime;
    let gyro = state.imu.gyroscope.z - bias;
    const sampleDelta = sampleTime === null ? 0 : state.sampleTime - sampleTime;
    if (fresh) {
      if (phase === 'calibrate') { biasSum += state.imu.gyroscope.z; biasSamples++; }
      else if (sampleTime !== null) yaw += gyro * (state.sampleTime - sampleTime);
      sampleTime = state.sampleTime;
    }
    const response = p.drive.responseTimeSec === 0 ? 1 : 1 - Math.exp(-dt / p.drive.responseTimeSec);
    left += (previousLeft - left) * response; right += (previousRight - right) * response;
    const rpmToMmSec = Math.PI * p.drive.wheelDiameterMm / 60;
    const speed = (left + right) / 2 * rpmToMmSec;
    // 用自身轮速指令的角速度预测跟踪零偏，抑制高噪声下长时间积分漂移。
    // 这里没有读取编码器/真实轮速，预测只来自上次输出与电机标定。
    if (fresh && phase !== 'calibrate') {
      const predictedOmega = (left-right)*rpmToMmSec/p.drive.wheelbaseMm;
      bias += (state.imu.gyroscope.z-predictedOmega-bias)*Math.min(1,sampleDelta/p.biasTrackSec);
      gyro = state.imu.gyroscope.z-bias;
    }
    const ds = speed * dt;
    distance += Math.abs(ds); x += ds * Math.cos(yaw); y += ds * Math.sin(yaw);
    const values = state.infrared.map(s => clamp((s.reflectance - p.darkReflectance) / (1 - p.darkReflectance), 0, 1));
    const total = values.reduce((a,b) => a+b, 0);
    const visible = Math.max(...values) > p.lineThreshold;
    const error = visible ? values.reduce((sum,v,i) => sum+v*(i-2),0) / total : 0;
    let contiguous = 0, longest = 0;
    for (const v of values) { contiguous = v > p.lineThreshold ? contiguous+1 : 0; longest = Math.max(longest, contiguous); }
    const broad = longest >= 3 && values[2] > p.lineThreshold;
    const centered = values[2] > p.lineThreshold && Math.abs(error) < p.centerTolerance && !broad;
    if (visible) lastSeen=distance;
    const emit = (l, r, label, complete = false) => {
      previousLeft = clamp(l,-p.maxRpm,p.maxRpm); previousRight = clamp(r,-p.maxRpm,p.maxRpm);
      return { leftRpm: previousLeft, rightRpm: previousRight,
        status: `${label} · ${leg+1}/${p.route.length} ${p.route[leg].name}`,
        complete, failed: phase === 'failed',
        telemetry: { phase, leg, turnConfirmations, lineCentered: centered, yaw, x, y, distance } };
    };
    const forward = (rpm, target = lineYaw) => {
      const correction = p.headingKp * (target-yaw) - p.headingKd * gyro;
      return emit(rpm+correction,rpm-correction, phase === 'approach' ? '红外路口对准' : '断线桥接');
    };
    const rotate = (omega, label) => {
      const rpm = omega * p.drive.wheelbaseMm / (2*rpmToMmSec);
      return emit(rpm,-rpm,label);
    };
    if (age > p.timeoutSec && phase !== 'complete') { failure = '总时间超限'; setPhase('failed'); }
    if (phase === 'failed') return emit(0,0,`安全停止：${failure}`);
    if (phase === 'complete') return emit(0,0,'已完成：回到发车区停车',true);
    if (phase === 'calibrate') {
      if (phaseAge >= p.calibrationSec) { bias = biasSum / Math.max(1,biasSamples); lastSeen = distance; setPhase('acquire'); }
      return emit(0,0,'静止标定陀螺仪零偏');
    }
    if (phase === 'acquire') {
      // 起步只接受较强反射，避免把发车区文字的灰色边缘当成引导线。
      if (Math.max(...values) > p.acquireThreshold) { acquired = true; lineYaw = yaw; lastSeen = distance; legStart = distance; setPhase('follow'); }
      else {
        if (phaseAge > p.acquireTimeoutSec) { failure = '起步未找到引导线'; setPhase('failed'); return emit(0,0,`安全停止：${failure}`); }
        if (Math.abs(rad(p.acquireSweepDeg)*sweepTarget-yaw) < rad(5)) sweepTarget *= -1;
        const omega = clamp(p.turnKp*(rad(p.acquireSweepDeg)*sweepTarget-yaw)-p.turnKd*gyro,-p.searchRadSec,p.searchRadSec);
        return rotate(omega,'起步搜线');
      }
    }
    if (phase === 'turn') {
      const angle = Math.sign(p.route[leg].turnDeg)*(yaw-turnBaseYaw);
      // 离开原方向后，必须连续捕获目标线才能结束旋转。
      if (fresh) confirmSamples = angle > rad(p.minTurnDeg) && centered ? confirmSamples+1 : 0;
      if (confirmSamples >= p.confirmSamples && Math.abs(gyro) < p.exitTurnRateRadSec) {
        // 前置模组可以在车身尚未摆正时扫到目标线；此时的瞬时朝向
        // 不能当成直线基准，保留入弯方向 + 路线相对转角，再由循线细调。
        lineYaw = turnBaseYaw+rad(p.route[leg].turnDeg);
        leg++; turnConfirmations++; legStart = distance;
        rearmAt = distance+p.eventRearmMm; bridgeUntil = distance; lastSeen = distance;
        previousBroad = false; lineStable = 0; setPhase('follow');
        return emit(p.exitRpm,p.exitRpm,'红外确认出弯');
      }
      if (angle > rad(p.maxTurnDeg) || phaseAge > p.turnTimeoutSec) setPhase('return');
      else {
        const direction = Math.sign(p.route[leg].turnDeg);
        const targetError = turnBaseYaw+rad(p.route[leg].turnDeg)-yaw;
        let omega = direction * (angle < rad(p.slowTurnDeg) ? p.maxTurnRadSec : p.searchRadSec);
        if (visible && angle > rad(p.captureMinDeg)) omega = p.turnLineKp*error-p.turnKd*gyro;
        else if (angle < rad(p.minTurnDeg)) omega = clamp(p.turnKp*targetError-p.turnKd*gyro,-p.maxTurnRadSec,p.maxTurnRadSec);
        const turnRpm=clamp(omega,-p.maxTurnRadSec,p.maxTurnRadSec)*p.drive.wheelbaseMm/(2*rpmToMmSec);
        const creep=visible && angle>rad(p.captureMinDeg) && angle<rad(p.minTurnDeg) ? p.turnCreepRpm : 0;
        return emit(creep+turnRpm,creep-turnRpm,'转向搜线');
      }
    }
    if (phase === 'return') {
      const e = turnBaseYaw-yaw;
      if (Math.abs(e) < rad(p.returnToleranceDeg) && Math.abs(gyro) < .3) {
        lineYaw = turnBaseYaw; bridgeUntil = distance+p.componentBridgeMm; rearmAt=distance+p.eventRearmMm;
        previousBroad=false; setPhase('follow');
      } else {
        if (phaseAge > p.turnTimeoutSec) { failure='侧向探测回正超时';setPhase('failed');return emit(0,0,`安全停止：${failure}`); }
        return rotate(clamp(p.turnKp*e-p.turnKd*gyro,-p.maxTurnRadSec,p.maxTurnRadSec),'排除元件横线');
      }
    }
    if (phase === 'approach') {
      // 仅按模组到轮轴的局部距离前移，连续横线以最后一个事件为准。
      if (fresh && broad && !previousBroad) anchor=distance+p.drive.sensorForwardMm+p.lineHalfWidthMm;
      previousBroad=broad;
      const remaining=anchor-distance;
      if (remaining < p.centerStopMm && Math.abs(speed)<p.scanEntrySpeedMmSec) {
        turnBaseYaw=lineYaw;
        if (p.route[leg].turnAt === 'end' && visible) {
          bridgeUntil=distance+p.componentBridgeMm; rearmAt=distance+p.eventRearmMm;
          previousBroad=false;lastSeen=distance;setPhase('follow');
          return forward(p.exitRpm);
        }
        setPhase('turn'); return rotate(0,'转向搜线');
      }
      const base=clamp(remaining/(rpmToMmSec*p.approachTimeSec),0,p.approachRpm);
      if (phaseAge>p.approachTimeoutSec) {failure='路口接近超时';setPhase('failed');return emit(0,0,`安全停止：${failure}`);}
      return forward(base);
    }
    if (phase === 'follow') {
      // 起步尚未建立稳定线方向时，丢线立即重新扫描，不能把文字误触发
      // 当成正常断线并按巡航速度盲走。
      if (initialLineYaw === null && !visible) {
        setPhase('acquire'); return emit(0,0,'起步重新搜线');
      }
      if (distance-lastSeen>p.maxBlindTravelMm) {failure='持续丢线';setPhase('failed');return emit(0,0,`安全停止：${failure}`);}
      if (centered && Math.abs(gyro)<p.lineLearnRateRadSec) lineStable+=dt; else lineStable=0;
      if (lineStable>p.lineLearnSec) {
        lineYaw += (yaw-lineYaw)*Math.min(1,dt/p.lineLearnTimeSec);
        if (initialLineYaw===null && distance>p.initialAlignMm) initialLineYaw=lineYaw;
      }
      if (leg===p.route.length-1 && initialLineYaw!==null) {
        // 起点没有唯一红外标记，只有最后停车使用累计的相对航位估计。
        const along=-(x*Math.cos(lineYaw)+y*Math.sin(lineYaw));
        if (distance-legStart>p.finishMinTravelMm && along<p.finishStopMm) {setPhase('complete');return emit(0,0,'已完成：回到发车区停车',true);}
      }
      if (leg<p.route.length-1 && distance>rearmAt && distance>bridgeUntil && distance-legStart>p.junctionMinTravelMm) {
        const lost=distance-lastSeen>p.lossProbeMm;
        if (broad || lost) {
          anchor=(broad?distance+p.lineHalfWidthMm:lastSeen-p.lineHalfWidthMm)+p.drive.sensorForwardMm;
          previousBroad=broad;setPhase('approach');return forward(p.approachRpm);
        }
      }
      if (!visible || broad || distance<bridgeUntil || (values[0]>p.lineThreshold && values[4]>p.lineThreshold)) return forward(p.cruiseRpm);
      const base=acquired && distance>p.initialAlignMm ? p.cruiseRpm : p.acquireRpm;
      const headingGuard=initialLineYaw!==null && distance-legStart>p.lineGuardAfterMm ? p.lineGuardKp*(lineYaw-yaw) : 0;
      const correction=clamp(p.lineKp*error+headingGuard-p.lineKd*gyro,-p.maxLineCorrectionRpm,p.maxLineCorrectionRpm);
      return emit(base+correction,base-correction,'循线');
    }
    return emit(0,0,'状态切换');
  };
}
