/**
 * 性能探针：帧时间窗口（120 帧）、场景资源计数、连续出帧基准（默认 60 帧，��� 10 帧）。
 * 基准结果含 fps / p50 / p95 / 资源快照；无 UI，仅 __dcxd.bench() / perf() 入口。
 */
import { PERF, summarizeSamples, round1, resourceDelta } from './perfplan.js';

export class Perf {
  constructor(deps = {}) {
    this.samples = [];
    this.frames = 0;
    this.cur = null;
    this.benchState = null;
    this.lastBench = null;
    this.getScene = deps.getScene || (() => null);
    this.getRenderer = deps.getRenderer || (() => null);
    this.invalidate = deps.invalidate || (() => {});
    this.getMeta = deps.getMeta || (() => ({}));
  }

  /** 记录一帧：frameMs = 帧间隔，renderMs = 渲染提交耗时（均毫秒） */
  recordFrame(frameMs, renderMs) {
    const dt = Number(frameMs);
    if (!(dt > 0) || dt > 2000) return;
    this.samples.push({ dt, renderMs: Number.isFinite(renderMs) ? renderMs : dt });
    if (this.samples.length > PERF.window * 2) this.samples.splice(0, this.samples.length - PERF.window);
    this.frames++;
    if (this.benchState) {
      this.benchState.done++;
      if (this.benchState.done < this.benchState.warmup) return;
      if (this.benchState.done >= this.benchState.warmup + this.benchState.frames && this.benchState.resolve) {
        const done = this.benchState;
        const taken = this.samples.slice(-done.frames);
        const stats = summarizeSamples(taken.map(s => s.dt), taken.map(s => s.renderMs));
        const out = {
          ...stats,
          label: done.label,
          frames: done.frames,
          warmup: done.warmup,
          elapsedMs: round1(performance.now() - done.t0),
          resources: this.resources(),
          meta: this.getMeta(),
        };
        this.lastBench = out;
        this.benchState = null;
        done.resolve(out);
      }
    }
  }

  get benchActive() {
    return !!this.benchState;
  }

  get bench() {
    const b = this.benchState;
    if (!b) return null;
    return { label: b.label, done: b.done, total: b.warmup + b.frames, warmup: b.warmup };
  }

  resources() {
    const scene = this.getScene();
    const renderer = this.getRenderer();
    let objects = 0;
    let meshes = 0;
    const materials = new Set();
    const sceneGeometries = new Set();
    if (scene) {
      scene.traverse(o => {
        objects++;
        if (o.isMesh) meshes++;
        if (o.material) {
          const list = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of list) if (m && m.uuid) materials.add(m.uuid);
        }
        if (o.geometry && o.geometry.uuid) sceneGeometries.add(o.geometry.uuid);
      });
    }
    const mem = renderer && renderer.info ? renderer.info.memory || {} : {};
    const ren = renderer && renderer.info ? renderer.info.render || {} : {};
    return {
      objects,
      meshes,
      materials: materials.size,
      sceneGeometries: sceneGeometries.size,
      geometries: Number.isFinite(mem.geometries) ? mem.geometries : null,
      textures: Number.isFinite(mem.textures) ? mem.textures : null,
      programs: Number.isFinite(mem.programs) ? mem.programs : null,
      drawCalls: Number.isFinite(ren.calls) ? ren.calls : Number.isFinite(ren.drawCalls) ? ren.drawCalls : null,
      triangles: Number.isFinite(ren.triangles) ? ren.triangles : null,
    };
  }

  summarize() {
    const taken = this.samples.slice(-PERF.window);
    return summarizeSamples(taken.map(s => s.dt), taken.map(s => s.renderMs));
  }

  bench_run(opts = {}) {
    if (this.benchState) return Promise.reject(new Error('已有性能基准在运行'));
    const frames = Math.max(10, Math.min(600, Number.isFinite(+opts.frames) ? Math.floor(+opts.frames) : 60));
    const warmup = Math.max(0, Math.min(30, Number.isFinite(+opts.warmup) ? Math.floor(+opts.warmup) : 10));
    const label = String(opts.label || 'bench').slice(0, 40);
    this.samples = [];
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const timer = setTimeout(() => {
        if (!this.benchState) return;
        const done = this.benchState;
        this.benchState = null;
        reject(new Error(`性能基准超时（${done.frames} 帧）`));
      }, 30000);
      this.benchState = {
        frames,
        warmup,
        label,
        done: 0,
        t0,
        resolve: stats => {
          clearTimeout(timer);
          resolve(stats);
        },
        reject,
      };
      this.invalidate();
    });
  }

  cancelBench() {
    if (!this.benchState) return false;
    const b = this.benchState;
    this.benchState = null;
    if (b.reject) b.reject(new Error('性能基准已取消'));
    return true;
  }

  info() {
    return {
      ...this.summarize(),
      frames: this.frames,
      benchActive: this.benchActive,
      bench: this.bench,
      lastBench: this.lastBench,
      window: PERF.window,
      budgets: PERF.budgets,
      resources: this.resources(),
      delta: this.lastBench ? resourceDelta(this.lastBench.resources, this.resources()) : null,
    };
  }
}
