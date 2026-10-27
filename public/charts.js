export class ImuChart {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.history = []; this.selected = 'accelerometer'; }
  add(sim) {
    this.history.push({ time: sim.time, imu: structuredClone(sim.imu) });
    const cutoff = sim.time - sim.config.view.historySeconds;
    while (this.history.length > 1 && this.history[0].time < cutoff) this.history.shift();
  }
  draw(sim) {
    const { canvas, ctx } = this, rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1, w = rect.width, h = rect.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const left = 32, top = 10, bottom = h - 17, right = w - 4;
    const values = this.history.flatMap(s => Object.values(s.imu[this.selected]));
    const lo = Math.min(0, ...values), hi = Math.max(1, ...values), pad = Math.max((hi - lo) * .14, .1), min = lo - pad, max = hi + pad;
    const projectY = y => bottom - (y - min) / (max - min) * (bottom - top);
    ctx.font = '8px Consolas, monospace'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#a3b1a8'; ctx.strokeStyle = '#e8efea'; ctx.lineWidth = .7;
    for (let i = 0; i < 3; i++) { const y = top + (bottom - top) * i / 2; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillText((max - (max - min) * i / 2).toFixed(1), 0, y); }
    for (let i = 0; i < 5; i++) { const x = left + (right - left) * i / 4; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); }
    ctx.fillText(`-${sim.config.view.historySeconds}s`, left, h - 5); ctx.textAlign = 'right'; ctx.fillText('现在', right, h - 5); ctx.textAlign = 'left';
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    for (const [axis, color] of [['x', '#218b68'], ['y', '#6e8fc4'], ['z', '#d09d51']]) {
      ctx.beginPath(); this.history.forEach((sample, i) => { const x = right - (sim.time - sample.time) / sim.config.view.historySeconds * (right - left), y = projectY(sample.imu[this.selected][axis]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.stroke();
    }
    ctx.restore();
  }
}
