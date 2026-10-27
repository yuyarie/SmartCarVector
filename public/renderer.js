import { clamp } from './core/sensors.mjs';

export class Renderer {
  constructor(canvas, config, image) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.config = config; this.image = image;
    this.trackHeight = config.track.widthMm * image.naturalHeight / image.naturalWidth;
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.followCar = config.view.followCar === true;
    this.width = 0; this.height = 0;
    this.resize(); this.fit();
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(rect.width * dpr) || this.canvas.height !== Math.round(rect.height * dpr)) {
      this.canvas.width = Math.round(rect.width * dpr); this.canvas.height = Math.round(rect.height * dpr);
      this.camera.x += (rect.width - this.width) / 2; this.camera.y += (rect.height - this.height) / 2;
    }
    this.width = rect.width; this.height = rect.height; this.dpr = dpr;
  }
  fit() {
    const pad = Math.min(this.config.view.fitPaddingPx, this.width / 4, this.height / 4);
    const z = Math.min((this.width - pad * 2) / this.config.track.widthMm, (this.height - pad * 2) / this.trackHeight);
    this.camera.zoom = clamp(z, this.config.view.minZoom, this.config.view.maxZoom);
    this.camera.x = (this.width - this.config.track.widthMm * this.camera.zoom) / 2;
    this.camera.y = (this.height - this.trackHeight * this.camera.zoom) / 2;
    this.fitZoom = this.camera.zoom;
  }
  screenToWorld(x, y) { return { xMm: (x - this.camera.x) / this.camera.zoom, yMm: (y - this.camera.y) / this.camera.zoom }; }
  zoomAt(x, y, factor) {
    const before = this.screenToWorld(x, y);
    this.camera.zoom = clamp(this.camera.zoom * factor, this.config.view.minZoom, this.config.view.maxZoom);
    this.camera.x = x - before.xMm * this.camera.zoom;
    this.camera.y = y - before.yMm * this.camera.zoom;
  }
  locate(pose) { this.camera.x = this.width / 2 - pose.xMm * this.camera.zoom; this.camera.y = this.height / 2 - pose.yMm * this.camera.zoom; }
  hitCar(x, y, pose) {
    const p = this.screenToWorld(x, y), dx = p.xMm - pose.xMm, dy = p.yMm - pose.yMm;
    const fx = Math.cos(pose.headingRad) * dx + Math.sin(pose.headingRad) * dy;
    const fy = -Math.sin(pose.headingRad) * dx + Math.cos(pose.headingRad) * dy;
    const v = this.config.vehicle, ir = this.config.infrared, margin = 8 / this.camera.zoom;
    const body = Math.abs(fx) < v.lengthMm / 2 + margin && Math.abs(fy) < v.widthMm / 2 + this.config.wheels.widthMm + margin;
    const front = Math.abs(fx - (v.lengthMm / 2 + ir.gapMm + ir.depthMm / 2)) < ir.depthMm / 2 + margin && Math.abs(fy) < ir.widthMm / 2 + margin;
    return body || front;
  }
  draw(sim, { suspendFollow = false } = {}) {
    this.resize();
    if (this.followCar && !suspendFollow) this.locate(sim.pose);
    const ctx = this.ctx, { width: w, height: h } = this, c = this.config, cam = this.camera, z = cam.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#111e2c'; ctx.fillRect(0, 0, w, h);
    if (c.view.showGrid) {
      const step = Math.max(c.view.gridMm, Math.ceil(18 / z / c.view.gridMm) * c.view.gridMm) * z;
      ctx.strokeStyle = '#233341'; ctx.lineWidth = .6; ctx.beginPath();
      for (let x = cam.x % step; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = cam.y % step; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
    }
    ctx.save(); ctx.translate(cam.x, cam.y); ctx.scale(z, z);
    ctx.shadowColor = '#0005'; ctx.shadowBlur = 30; ctx.drawImage(this.image, 0, 0, c.track.widthMm, this.trackHeight); ctx.shadowBlur = 0;
    ctx.strokeStyle = '#5e72bc50'; ctx.lineWidth = 1 / z; ctx.strokeRect(0, 0, c.track.widthMm, this.trackHeight);
    if (c.view.showTrail && sim.trail.length > 1) {
      ctx.beginPath(); sim.trail.forEach((p, i) => i ? ctx.lineTo(p.xMm, p.yMm) : ctx.moveTo(p.xMm, p.yMm));
      ctx.strokeStyle = '#f3bb77cc'; ctx.lineWidth = 2 / z; ctx.setLineDash([4 / z, 4 / z]); ctx.stroke(); ctx.setLineDash([]);
    }
    this.drawCar(sim, z);
    if (c.view.showSensorFootprints) {
      for (const sensor of sim.infrared) {
        ctx.beginPath(); ctx.arc(sensor.xMm, sensor.yMm, Math.max(c.infrared.sampleRadiusMm, 2.5 / z), 0, Math.PI * 2);
        ctx.fillStyle = sensor.detected ? '#56efb4' : '#91b6ad'; ctx.fill();
        ctx.strokeStyle = '#092c24'; ctx.lineWidth = .8 / z; ctx.stroke();
      }
    }
    ctx.restore();
  }
  drawCar(sim, z) {
    const ctx = this.ctx, c = this.config, { vehicle: v, wheels: wh, infrared: ir } = c, p = sim.pose;
    ctx.save(); ctx.translate(p.xMm, p.yMm); ctx.rotate(p.headingRad);
    // 轮轴始终位于矩形车身两侧的纵向中心。
    const axle = (v.widthMm + wh.widthMm + wh.gapMm * 2) / 2;
    for (const [side, y] of [['left', -axle], ['right', axle]]) {
      ctx.fillStyle = '#09161e'; ctx.strokeStyle = '#a1b1b2'; ctx.lineWidth = 1 / z;
      ctx.beginPath(); ctx.roundRect(-wh.diameterMm / 2, y - wh.widthMm / 2, wh.diameterMm, wh.widthMm, 3); ctx.fill(); ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.rect(-wh.diameterMm / 2, y - wh.widthMm / 2, wh.diameterMm, wh.widthMm); ctx.clip();
      ctx.strokeStyle = '#6b8386'; ctx.lineWidth = 1 / z;
      const pitch = wh.diameterMm / 4, offset = sim.wheels[`${side}AngleRad`] / (Math.PI * 2) * wh.diameterMm;
      for (let x = -wh.diameterMm; x <= wh.diameterMm; x += pitch) { ctx.beginPath(); ctx.moveTo(x + offset, y - wh.widthMm / 2 + 2); ctx.lineTo(x + offset, y + wh.widthMm / 2 - 2); ctx.stroke(); }
      ctx.restore();
    }
    const front = v.lengthMm / 2 + ir.gapMm;
    ctx.strokeStyle = '#b9d5cb'; ctx.lineWidth = Math.max(3, 1.3 / z);
    for (const y of [-ir.widthMm * .27, ir.widthMm * .27]) { ctx.beginPath(); ctx.moveTo(v.lengthMm / 2 - 5, y); ctx.lineTo(front + 2, y); ctx.stroke(); }
    ctx.fillStyle = '#d9eae5'; ctx.shadowColor = '#001b3e90'; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.roundRect(-v.lengthMm / 2, -v.widthMm / 2, v.lengthMm, v.widthMm, 6); ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = '#a1c9b7'; ctx.lineWidth = 1 / z; ctx.stroke();
    ctx.fillStyle = '#366d5a'; ctx.fillRect(-v.lengthMm * .28, -v.widthMm * .32, v.lengthMm * .37, v.widthMm * .64);
    ctx.fillStyle = '#679786'; ctx.fillRect(-v.lengthMm * .23, -v.widthMm * .25, v.lengthMm * .15, v.widthMm * .5);
    ctx.strokeStyle = '#a0cdb6'; ctx.lineWidth = 1 / z;
    for (let i = 0; i < 4; i++) { const y = -v.widthMm * .22 + i * v.widthMm * .145; ctx.beginPath(); ctx.moveTo(-v.lengthMm * .04, y); ctx.lineTo(v.lengthMm * .04, y); ctx.stroke(); }
    ctx.strokeStyle = '#278d68'; ctx.lineWidth = 2 / z; ctx.beginPath(); ctx.moveTo(v.lengthMm * .18, 0); ctx.lineTo(v.lengthMm * .34, 0); ctx.moveTo(v.lengthMm * .27, -v.widthMm * .09); ctx.lineTo(v.lengthMm * .34, 0); ctx.lineTo(v.lengthMm * .27, v.widthMm * .09); ctx.stroke();
    ctx.fillStyle = '#122e28'; ctx.strokeStyle = '#78b39e'; ctx.lineWidth = 1 / z;
    ctx.beginPath(); ctx.roundRect(front, -ir.widthMm / 2, ir.depthMm, ir.widthMm, 2); ctx.fill(); ctx.stroke();
    // 选中角标保持固定屏幕线宽。
    const pad = 8 / z, len = 7 / z, x0 = -v.lengthMm / 2 - pad, x1 = v.lengthMm / 2 + pad, y0 = -v.widthMm / 2 - pad, y1 = v.widthMm / 2 + pad;
    ctx.strokeStyle = '#60ecb4'; ctx.lineWidth = 1 / z; ctx.beginPath();
    for (const [x, y, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) { ctx.moveTo(x + sx * len, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * len); }
    ctx.stroke(); ctx.restore();
  }
}
