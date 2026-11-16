/**
 * 材质与程序纹理库：全部由 Canvas 程序化生成，无外部图片依赖。
 * 观感基准：HPL 防静电地板、彩钢板墙面、混凝土柱、网孔门机柜、U 位孔条、网格桥架、柜内指示灯等。
 */
import * as THREE from 'three/webgpu';
import { cabPaint, normalizeCabColor, rgbaHex, hexInt } from '../data/color.js';

/** mm → m */
export const S = 0.001;

/** 绘制坐标保持逻辑尺寸，整体放大 k 倍（高 DPI 与近景细节） */
function ctex(w, h, draw, k = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const x = c.getContext('2d');
  if (k !== 1) x.scale(k, k);
  draw(x, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function speckle(x, w, h, n, alpha, light = false) {
  for (let i = 0; i < n; i++) {
    x.fillStyle = light ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
    x.fillRect(Math.random() * w, Math.random() * h, 1.4, 1.4);
  }
}

/** 静电地板砖：一帧 = 600×600mm */
export const floorTex = ctex(96, 96, (x, w, h) => {
  x.fillStyle = '#d3d7db';
  x.fillRect(0, 0, w, h);
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, 'rgba(255,255,255,.14)');
  g.addColorStop(1, 'rgba(0,0,0,.07)');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  speckle(x, w, h, 240, 0.05);
  speckle(x, w, h, 120, 0.05, true);
  x.strokeStyle = '#8f959c';
  x.lineWidth = 2;
  x.strokeRect(1, 1, w - 2, h - 2);
  x.fillStyle = '#848b92';
  for (const [cx, cy] of [[4, 4], [w - 4, 4], [4, h - 4], [w - 4, h - 4]]) {
    x.fillRect(cx - 2, cy - 2, 4, 4);
  }
}, 4);

/** 吊顶板：一帧 = 600×600mm，四边各半根龙骨，平铺合成 600 模数网格 */
export const ceilTex = ctex(96, 96, (x, w, h) => {
  x.fillStyle = '#f2f3f4';
  x.fillRect(0, 0, w, h);
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, 'rgba(255,255,255,.10)');
  g.addColorStop(1, 'rgba(0,0,0,.05)');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  speckle(x, w, h, 260, 0.045);
  speckle(x, w, h, 120, 0.05, true);
  const bw = 2.4;
  x.fillStyle = '#b6bdc6';
  x.fillRect(0, 0, w, bw);
  x.fillRect(0, h - bw, w, bw);
  x.fillRect(0, 0, bw, h);
  x.fillRect(w - bw, 0, bw, h);
  x.fillStyle = 'rgba(0,0,0,.22)';
  x.fillRect(0, bw, w, 1);
  x.fillRect(0, h - bw - 1, w, 1);
  x.fillRect(bw, 0, 1, h);
  x.fillRect(w - bw - 1, 0, 1, h);
}, 4);

/** 吊顶上面（室外俯视）网格线：透明底，仅龙骨与缝线可见 */
export const ceilGridTex = ctex(96, 96, (x, w, h) => {
  x.clearRect(0, 0, w, h);
  x.fillStyle = 'rgba(255,255,255,.02)';
  x.fillRect(0, 0, w, h);
  const bw = 2.4;
  x.fillStyle = 'rgba(228,234,240,.5)';
  x.fillRect(0, 0, w, bw);
  x.fillRect(0, h - bw, w, bw);
  x.fillRect(0, 0, bw, h);
  x.fillRect(w - bw, 0, bw, h);
  x.fillStyle = 'rgba(35,45,55,.28)';
  x.fillRect(0, 0, w, 0.8);
  x.fillRect(0, h - 0.8, w, 0.8);
  x.fillRect(0, 0, 0.8, h);
  x.fillRect(w - 0.8, 0, 0.8, h);
}, 4);

/** 彩钢板墙面：一帧 = 1200×1200mm，600 模数竖缝 */
export const wallTex = ctex(128, 128, (x, w, h) => {
  x.fillStyle = '#e6e9ec';
  x.fillRect(0, 0, w, h);
  speckle(x, w, h, 150, 0.03);
  x.strokeStyle = 'rgba(118,128,138,.5)';
  x.lineWidth = 1.4;
  x.beginPath();
  x.moveTo(0.7, 0);
  x.lineTo(0.7, h);
  x.moveTo(w / 2 + 0.7, 0);
  x.lineTo(w / 2 + 0.7, h);
  x.stroke();
  x.strokeStyle = 'rgba(255,255,255,.5)';
  x.beginPath();
  x.moveTo(2, 0);
  x.lineTo(2, h);
  x.moveTo(w / 2 + 2, 0);
  x.lineTo(w / 2 + 2, h);
  x.stroke();
}, 4);

/** 混凝土 */
export const concreteTex = ctex(128, 128, (x, w, h) => {
  x.fillStyle = '#c0c4c7';
  x.fillRect(0, 0, w, h);
  speckle(x, w, h, 700, 0.06);
  speckle(x, w, h, 320, 0.05, true);
}, 4);

/** 机柜网孔：一帧 = 50×50mm，交错冲孔 + 孔沿高光（9 宫格环绕绘制保证平铺无缝） */
function makeRackPerfTex(base, ring) {
  return ctex(64, 64, (x, w, h) => {
    x.fillStyle = base;
    x.fillRect(0, 0, w, h);
    speckle(x, w, h, 60, 0.05);
    speckle(x, w, h, 30, 0.04, true);
    const pitch = w / 5;
    const r = pitch * 0.28;
    const holes = [];
    for (let row = 0, yy = pitch / 2; yy < h; yy += pitch, row++) {
      for (let xx = pitch / 2 + (row % 2) * (pitch / 2); xx < w; xx += pitch) holes.push([xx, yy]);
    }
    const ring9 = (cx, cy, rr, style) => {
      x.fillStyle = style;
      for (const dx of [-w, 0, w]) {
        for (const dy of [-h, 0, h]) {
          x.beginPath();
          x.arc(cx + dx, cy + dy, rr, 0, Math.PI * 2);
          x.fill();
        }
      }
    };
    for (const [hx, hy] of holes) ring9(hx, hy, r + 1.5, ring);
    x.globalCompositeOperation = 'destination-out';
    for (const [hx, hy] of holes) ring9(hx, hy, r, '#000');
  }, 4);
}
export const rackPerfTex = makeRackPerfTex('#2e333a', 'rgba(205,214,224,.55)');

/** U 位立柱孔条：一帧 = 35mm 宽 × 178mm（4U） */
export const rackColTex = ctex(35, 178, (x, w, h) => {
  x.fillStyle = '#2a2f36';
  x.fillRect(0, 0, w, h);
  speckle(x, w, h, 40, 0.05);
  x.fillStyle = 'rgba(255,255,255,.12)';
  x.fillRect(0, 0, 2, h);
  x.fillRect(w - 2.5, 0, 1.2, h);
  x.fillStyle = 'rgba(0,0,0,.4)';
  x.fillRect(3, 0, 2.2, h);
  x.fillRect(w - 5.5, 0, 2.2, h);
  const U = h / 4;
  for (let u = 0; u < 4; u++) {
    for (const f of [0.2, 0.5, 0.8]) {
      const cy = (u + f) * U;
      x.fillStyle = 'rgba(200,208,216,.45)';
      x.fillRect(w / 2 - 5, cy - 5, 10, 10);
      x.fillStyle = '#04060a';
      x.fillRect(w / 2 - 4, cy - 4, 8, 8);
    }
  }
}, 4);

/** 柜内设备灯板：一帧 = 4U */
export const ledTex = ctex(96, 48, (x, w, h) => {
  const U = h / 4;
  const cols = ['#3fd97e', '#3fd97e', '#3fd97e', '#3fd97e', '#f2b134', '#2f81f7'];
  x.fillStyle = '#0b0d10';
  x.fillRect(0, 0, w, h);
  for (let u = 0; u < 4; u++) {
    const y0 = u * U;
    x.fillStyle = 'rgba(255,255,255,.07)';
    x.fillRect(0, y0, w, 1);
    x.fillStyle = 'rgba(0,0,0,.55)';
    x.fillRect(0, y0 + U - 1, w, 1);
    const n = 1 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      x.fillStyle = cols[(Math.random() * cols.length) | 0];
      x.fillRect(5 + i * 4 + Math.random(), y0 + U / 2 - 1, 2, 2);
    }
    x.fillStyle = 'rgba(255,255,255,.05)';
    for (let sx = w * 0.45; sx < w - 6; sx += 5) x.fillRect(sx, y0 + U / 2 - 2, 2.4, 4);
  }
}, 4);

/** 地板风口 · 格栅 */
export const ventGrilleTex = ctex(96, 96, (x, w, h) => {
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, h);
  x.fillStyle = '#e8ebee';
  for (let y = 9; y < h - 5; y += 12) x.fillRect(9, y, w - 18, 4);
  x.strokeStyle = '#dde1e5';
  x.lineWidth = 3;
  x.strokeRect(1.5, 1.5, w - 3, h - 3);
}, 4);

/** 地板风口 · 孔板 */
export const ventPerfTex = ctex(96, 96, (x, w, h) => {
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, h);
  x.fillStyle = '#e8ebee';
  for (let y = 9; y < h - 5; y += 9) {
    for (let xx = 9; xx < w - 5; xx += 9) {
      x.beginPath();
      x.arc(xx, y, 2.2, 0, Math.PI * 2);
      x.fill();
    }
  }
  x.strokeStyle = '#dde1e5';
  x.lineWidth = 3;
  x.strokeRect(1.5, 1.5, w - 3, h - 3);
}, 4);

/** 网格桥架钢丝网：一帧 = 100×100mm（纵丝 100 / 横丝 50） */
export const meshTrayTex = ctex(128, 128, (x, w, h) => {
  const wire = (x0, y0, x1, y1) => {
    x.strokeStyle = '#7d838a';
    x.lineWidth = 9;
    x.lineCap = 'round';
    x.beginPath();
    x.moveTo(x0, y0);
    x.lineTo(x1, y1);
    x.stroke();
    x.strokeStyle = '#ced3d9';
    x.lineWidth = 4.5;
    x.beginPath();
    x.moveTo(x0, y0);
    x.lineTo(x1, y1);
    x.stroke();
  };
  wire(0, -5, 0, h + 5);
  wire(w, -5, w, h + 5);
  wire(-5, 0, w + 5, 0);
  wire(-5, h / 2, w + 5, h / 2);
  wire(-5, h, w + 5, h);
  x.fillStyle = '#c3c9d0';
  for (const dx of [0, w]) {
    for (const dy of [0, h / 2, h]) {
      x.beginPath();
      x.arc(dx, dy, 6, 0, Math.PI * 2);
      x.fill();
    }
  }
}, 4);

/** 克隆纹理并设置重复次数（图像共享，UV 独立） */
export function rep(tex, rx, ry) {
  const t = tex.clone();
  t.repeat.set(Math.max(rx, 0.01), Math.max(ry, 0.01));
  t.needsUpdate = true;
  return t;
}

/** 共享材质集 */
export const REAL = {
  plenum: new THREE.MeshStandardMaterial({ color: 0x3f454c, roughness: 0.95, metalness: 0 }),
  concrete: new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.95, metalness: 0 }),
  rackBody: new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.55, metalness: 0.5 }),
  rackFrame: new THREE.MeshStandardMaterial({ color: 0x363b43, roughness: 0.5, metalness: 0.55 }),
  rackColSide: new THREE.MeshStandardMaterial({ color: 0x30353d, roughness: 0.5, metalness: 0.5 }),
  rackInner: new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.95, metalness: 0.1 }),
  handleMetal: new THREE.MeshStandardMaterial({ color: 0x909aa4, roughness: 0.3, metalness: 0.9 }),
  pduBody: new THREE.MeshStandardMaterial({ color: 0x353a42, roughness: 0.5, metalness: 0.5 }),
  pduStripe: new THREE.MeshStandardMaterial({ color: 0xc39113, roughness: 0.5, metalness: 0.55 }),
  acBody: new THREE.MeshStandardMaterial({ color: 0x464e57, roughness: 0.55, metalness: 0.45 }),
  upsBody: new THREE.MeshStandardMaterial({ color: 0x3a4149, roughness: 0.5, metalness: 0.5 }),
  upsStripe: new THREE.MeshStandardMaterial({ color: 0xd2a52c, roughness: 0.45, metalness: 0.6 }),
  batBody: new THREE.MeshStandardMaterial({ color: 0x403c34, roughness: 0.55, metalness: 0.5 }),
  batCell: new THREE.MeshStandardMaterial({ color: 0x2b4a38, roughness: 0.6, metalness: 0.3 }),
  batPole: new THREE.MeshStandardMaterial({ color: 0xc9a23b, roughness: 0.4, metalness: 0.8 }),
  extBody: new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.45, metalness: 0.5 }),
  extHose: new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: 0.7, metalness: 0.3 }),
  acPanel: new THREE.MeshStandardMaterial({ color: 0x30363e, roughness: 0.6, metalness: 0.4 }),
  acScreen: new THREE.MeshBasicMaterial({ color: 0x79c7e8 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xb7bcc2, roughness: 0.4, metalness: 0.85 }),
  aluminum: new THREE.MeshStandardMaterial({ color: 0xc6ccd3, roughness: 0.35, metalness: 0.9 }),
  doorSteel: new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.5, metalness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0xa8c8dc, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false,
  }),
  grilleFrame: new THREE.MeshStandardMaterial({ color: 0xf4f6f8, roughness: 0.45, metalness: 0.1 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2f343b, roughness: 0.8, metalness: 0.3 }),
};

export const M = { ...REAL };

/** 动态共享材质（按柜色/尺寸缓存；超上限整体清空，旧材质随下次重建释放） */
const DYN = new Map();
const DYN_CAP = 240;
function dynMat(key, make) {
  if (!DYN.has(key)) {
    if (DYN.size >= DYN_CAP) DYN.clear();
    DYN.set(key, make());
  }
  return DYN.get(key);
}

function paint3D(hex) {
  const c = normalizeCabColor(hex);
  return c ? cabPaint(c) : null;
}

const perfTexCache = new Map();
function perfTexFor(body, edge) {
  const k = body + '|' + edge;
  if (!perfTexCache.has(k)) {
    if (perfTexCache.size >= 32) perfTexCache.clear();
    perfTexCache.set(k, makeRackPerfTex(body, rgbaHex(edge, 0.5)));
  }
  return perfTexCache.get(k);
}

/** 机柜柜身材质（侧板/底板/顶盖） */
export function rackBodyMat(hex) {
  const pc = paint3D(hex);
  if (!pc) return M.rackBody;
  return dynMat(`cabBody${pc.body}`, () => new THREE.MeshStandardMaterial({
    color: hexInt(pc.body), roughness: 0.5, metalness: 0.6,
  }));
}

/** 门框梁 / 立柱净面材质（kind = 'frame' | 'col'） */
export function rackFrameMat(hex, kind = 'frame') {
  const pc = paint3D(hex);
  if (!pc) return kind === 'col' ? M.rackColSide : M.rackFrame;
  return dynMat(`cab${kind === 'col' ? 'ColSide' : 'Frame'}${pc.front}`, () => new THREE.MeshStandardMaterial({
    color: hexInt(pc.front),
    roughness: kind === 'col' ? 0.5 : 0.45,
    metalness: kind === 'col' ? 0.65 : 0.7,
  }));
}

/** 机柜网孔门材质（50mm 模数平铺） */
export function rackPerfMat(wmm, hmm, hex) {
  const rx = Math.max(1, Math.round(wmm / 50));
  const ry = Math.max(1, Math.round(hmm / 50));
  const pc = paint3D(hex);
  if (!pc) {
    return dynMat(`rackPerf${rx}x${ry}`, () => new THREE.MeshStandardMaterial({
      map: rep(rackPerfTex, rx, ry), alphaTest: 0.45, roughness: 0.5, metalness: 0.55, side: THREE.DoubleSide,
    }));
  }
  return dynMat(`rackPerf${rx}x${ry}|${pc.body}`, () => new THREE.MeshStandardMaterial({
    map: rep(perfTexFor(pc.body, pc.edge), rx, ry),
    alphaTest: 0.45,
    roughness: 0.5,
    metalness: 0.55,
    side: THREE.DoubleSide,
  }));
}

/** U 位立柱正面材质（178mm = 4U 孔条） */
export function rackColFaceMat(colH, hex) {
  const ry = Math.max(1, Math.round(colH / 178));
  const pc = paint3D(hex);
  if (!pc) {
    return dynMat(`rackCol${ry}`, () => new THREE.MeshStandardMaterial({
      map: rep(rackColTex, 1, ry), roughness: 0.35, metalness: 0.8,
    }));
  }
  return dynMat(`rackCol${ry}|${pc.body}`, () => new THREE.MeshStandardMaterial({
    color: hexInt(pc.front), roughness: 0.35, metalness: 0.8,
  }));
}

/** 柜内设备灯板材质 */
export function rackLedMat(hmm) {
  const ry = Math.max(1, Math.round(hmm / 178));
  return dynMat(`rackLed${ry}`, () => new THREE.MeshBasicMaterial({ map: rep(ledTex, 1, ry) }));
}

/** 全部共享材质（重建时不销毁） */
export function sharedMaterials() {
  return [...Object.values(REAL), ...DYN.values()];
}
