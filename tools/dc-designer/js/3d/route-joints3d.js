/** 展示级接头规划：mm 业务坐标，只读源对象；无 DOM/Three.js 依赖，不代表管件拓扑。 */
import { normalizePipe, pipeGeometry, pipeColor, PIPE_EPS, segmentDistance3D } from '../pipe-geometry.js';

export const JOINT_DEFAULTS = Object.freeze({ enabled: true, pipeRadius: 0, trayInnerRadius: 200 });
export function normalizeJointOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const out = { ...JOINT_DEFAULTS, enabled: input.enabled !== false };
  for (const k of ['pipeRadius', 'trayInnerRadius']) {
    const v = input[k];
    if ((typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(+v) && +v >= 0 && +v <= 10000) out[k] = +v;
  }
  return out;
}
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, s) => a.map(v => v * s);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => mul(a, 1 / Math.hypot(...a));
const distance = (a, b) => Math.hypot(...sub(a, b));
const near = (a, b) => Math.abs(a - b) <= PIPE_EPS;
const boundsOf = (points,r=0) => [0,1,2].map(i => [Math.min(...points.map(p=>p[i]))-r,Math.max(...points.map(p=>p[i]))+r]);
const boundsOverlap = (a,b) => a.every(([lo,hi],i) => lo <= b[i][1] && hi >= b[i][0]);
export const segmentObject = (a, b) => ({ x1:a[0], y1:a[1], z1:a[2], x2:b[0], y2:b[1], z2:b[2] });

/** 精确圆弧及导数；x/y 是弧平面内的单位基，不是世界坐标轴。 */
export function arcPoint(arc, t) {
  const q = arc.angle * t;
  return add(arc.center, mul(add(mul(arc.x, Math.cos(q)), mul(arc.y, Math.sin(q))), arc.radius));
}
export function arcTangent(arc, t) {
  const q = arc.angle * t;
  return add(mul(arc.x, -Math.sin(q)), mul(arc.y, Math.cos(q)));
}

function entry(o, meta) {
  if (o.type === 'pipe') {
    try {
      const n = normalizePipe(o), g = pipeGeometry(n);
      return { o, props:n.props, type:o.type, a:[n.x1,n.y1,n.z1], b:[n.x2,n.y2,n.z2],
        radius:g.outerRadius, color:pipeColor(n, meta), trims:[0,0], ends:[null,null] };
    } catch { return null; }
  }
  if (o.type !== 'tray') return null;
  const p = o.props || {}, w = +(p.width || 300), h = +(p.bodyH || 100), z = +(p.height || 2500);
  if (![o.x1,o.y1,o.x2,o.y2,w,h,z].every(Number.isFinite) || w <= 6 || h <= 6 || Math.hypot(o.x2-o.x1,o.y2-o.y1) < 1) return null;
  return { o, type:o.type, props:p, width:w, height:h, a:[o.x1,o.y1,z], b:[o.x2,o.y2,z],
    radius:Math.hypot(w/2,h/2), trims:[0,0], ends:[null,null] };
}
function compatible(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'tray') return near(a.width,b.width) && near(a.height,b.height) && near(a.a[2],b.a[2]) &&
    (a.props.kind || '弱电') === (b.props.kind || '弱电') && (a.props.structure || '') === (b.props.structure || '');
  return ['systemId','circuitId'].every(k => (a.o[k] || '') === (b.o[k] || '')) &&
    ['side','loopSide','material','nominalSize'].every(k => a.props[k] === b.props[k]) &&
    ['outsideDiameter','insulationThickness'].every(k => near(a.props[k], b.props[k])) &&
    a.props.wallThickness === b.props.wallThickness && a.color === b.color;
}
function interior(p, e) {
  const v = sub(e.b,e.a), l2 = dot(v,v), t = dot(sub(p,e.a),v)/l2;
  return t > PIPE_EPS/Math.sqrt(l2) && t < 1-PIPE_EPS/Math.sqrt(l2) && distance(p,add(e.a,mul(v,t))) <= PIPE_EPS;
}

/** 空间哈希查三维端点；平面交叉、不同 Z、不同系统不产生隐藏连接。 */
export function planJoints(objects = [], input = {}, meta = {}) {
  const options = normalizeJointOptions(input), entries = new Map(), bends = [], skipped = [];
  for (const o of objects) { const e = entry(o,meta); if (e) { e.length = distance(e.a,e.b); entries.set(o,e); } }
  const report = (ids, reason) => skipped.push({ ids, reason });
  const result = { options, entries, bends, skipped, risks:[] };
  if (!options.enabled) return result;
  const all = [...entries.values()];
  for (const e of all) e.rawBounds = boundsOf([e.a,e.b],PIPE_EPS);
  const buckets = new Map(), nodes = [];
  for (const e of entries.values()) for (const i of [0,1]) {
    const p = i ? e.b : e.a, cell = p.map(v => Math.floor(v/PIPE_EPS));
    let found;
    for (let x=-1;x<=1;x++) for(let y=-1;y<=1;y++) for(let z=-1;z<=1;z++) {
      const key = `${e.type}|${cell[0]+x}|${cell[1]+y}|${cell[2]+z}`;
      for (const n of buckets.get(key) || []) if (distance(p,n.p) <= PIPE_EPS && !found) found = n;
    }
    if (!found) {
      found = { p:p.slice(), ends:[] }; nodes.push(found);
      const key = `${e.type}|${cell.join('|')}`;
      if (!buckets.has(key)) buckets.set(key,[]);
      buckets.get(key).push(found);
    }
    found.ends.push({e,i});
  }
  const candidates = [];
  for (const node of nodes) {
    if (node.ends.length < 2) continue;
    const ids = [...new Set(node.ends.map(v => v.e.o.id))];
    if (node.ends.length !== 2 || node.ends[0].e === node.ends[1].e) { report(ids,'branch'); continue; }
    const [a,b] = node.ends, ea = a.e, eb = b.e;
    if (!compatible(ea,eb)) { report(ids,'mismatch'); continue; }
    // 第三段的内部落在此节点：同样属于分支，不能错误补普通圆弯。
    if (all.some(e => e !== ea && e !== eb && e.type === ea.type && e.rawBounds.every(([lo,hi],i)=>node.p[i]>=lo&&node.p[i]<=hi) && interior(node.p,e))) { report(ids,'branch'); continue; }
    const va = unit(sub(a.i ? ea.a : ea.b,node.p)), vb = unit(sub(b.i ? eb.a : eb.b,node.p));
    const angle = Math.acos(Math.max(-1,Math.min(1,-dot(va,vb))));
    if (angle < 1e-6) continue; // 共线直行无需弯头
    if (angle < Math.PI/36 || angle > Math.PI*5/6) { report(ids,'angle'); continue; }
    const radius = ea.type === 'tray' ? options.trayInnerRadius + ea.width/2 :
      options.pipeRadius || Math.max(ea.props.outsideDiameter*2.5,ea.radius*1.25);
    if (radius <= (ea.type === 'tray' ? ea.width/2+3 : ea.radius+PIPE_EPS)) { report(ids,'radius'); continue; }
    const trim = radius*Math.tan(angle/2), incoming = mul(va,-1), normal = unit(cross(incoming,vb));
    const inward = cross(normal,incoming), start = add(node.p,mul(va,trim));
    const arc = { center:add(start,mul(inward,radius)), x:mul(inward,-1), y:incoming, normal, angle, radius,
      ids, type:ea.type, outerRadius:ea.radius, height:ea.height || 0, a, b, trim };
    candidates.push(arc);
  }
  // 两端弯头裁短总量一起校验；空间不足时整对回退，决不负长度或悄悄缩小指定半径。
  const totals = new Map();
  for (const c of candidates) for (const {e} of [c.a,c.b]) totals.set(e,(totals.get(e)||0)+c.trim);
  for (const c of candidates) {
    if ([c.a,c.b].some(({e}) => (totals.get(e)||0) >= e.length-1)) { report(c.ids,'short'); continue; }
    for (const [end,t] of [[c.a,0],[c.b,1]]) {
      end.e.trims[end.i] = c.trim;
      end.e.ends[end.i] = { arc:c, cut:t };
      // 只在确认能生成后，渲染副本才统一容差内的端点；源数据始终不变。
      end.e[end.i ? 'b' : 'a'] = arcPoint(c,t);
    }
    bends.push(c);
  }
  assignTrayUV(entries);
  return result;
}

/** 半弧用解析弧长，直段用欧氏距离；side 为路径左侧的毫米偏移。 */
export function sampleStepLength(prev, sample, side = 0) {
  if (sample.arc && sample.arc === prev.arc) {
    const direction = dot(arcTangent(sample.arc,sample.u),sample.t);
    return Math.abs(sample.u-prev.u)*sample.arc.angle*(sample.arc.radius-sample.arc.normal[2]*direction*side);
  }
  return distance(sample.p,prev.p);
}

/** 将同一桥架链的网格纹理距离跨对象传递；反向存储的线段同时反转横向 UV。闭环只保留种子处一条纹理接缝。 */
function assignTrayUV(entries) {
  const metrics = new Map();
  for (const e of entries.values()) if (e.type === 'tray' && e.ends.some(Boolean)) {
    const samples=routeSamples(e);let length=0,slope=0;
    for(let i=1;i<samples.length;i++) {const d=sampleStepLength(samples[i-1],samples[i]);length+=d;slope+=sampleStepLength(samples[i-1],samples[i],1)-d;}
    metrics.set(e,{length,slope});
  }
  for (const seed of metrics.keys()) {
    if(seed.texSign)continue;
    seed.texSign=1;seed.texStart=0;seed.texSide=0;const queue=[seed];
    for(let i=0;i<queue.length;i++) {
      const e=queue[i],m=metrics.get(e);
      for(const endIndex of [0,1]) {
        const end=e.ends[endIndex];if(!end)continue;
        const other=end.arc.a.e===e?end.arc.b:end.arc.a,next=other.e;
        if(next.texSign)continue;
        const factor=endIndex===other.i?-1:1,nm=metrics.get(next);
        const at=e.texStart+e.texSign*(endIndex?m.length:0),side=e.texSide+e.texSign*(endIndex?m.slope:0);
        next.texSign=e.texSign*factor;
        next.texStart=at-next.texSign*(other.i?nm.length:0);
        next.texSide=side*factor-next.texSign*(other.i?nm.slope:0);
        queue.push(next);
      }
    }
  }
}

/** 每个对象占半个弯头。独立拾取/隔离仍属于原对象，且不重复创建整个弯头。 */
export function routeSamples(e) {
  const out = [], tangent = unit(sub(e.b,e.a));
  const append = (p,t,n,arc=null,u=null) => {
    if (out.length && distance(out.at(-1).p,p) < 1e-6) return;
    out.push({p,t,n,arc,u});
  };
  for (const i of [0,1]) {
    const end = e.ends[i];
    if (!end) { append(i ? e.b : e.a,tangent,null); continue; }
    const from = i ? end.cut : .5, to = i ? .5 : end.cut, sign = Math.sign(to-from);
    const steps = Math.max(3,Math.ceil(Math.abs(to-from)*end.arc.angle/(Math.PI/36)));
    for (let j=0;j<=steps;j++) {
      const t = from+(to-from)*j/steps;
      append(arcPoint(end.arc,t),mul(arcTangent(end.arc,t),sign),end.arc.normal,end.arc,t);
    }
  }
  return out;
}

/** 新增弯曲区域的保守风险。采样胶囊外扩弦高，不作为施工碰撞/规范结论。 */
export function jointPipeRisks(plan, objects, deviceDistance, roomH = 3000, floorH = 400) {
  const risks = [], resolve = id => objects.find(o => o.id === id), seen = new Set(), envelopes = [], pipeEnvelopes = new Map();
  if (!plan.bends.length) return risks;
  // 每次 build 验证一次，不在每个弧段/每根被检管之间反复规范化。
  for (const o of objects) if (o.type === 'pipe') {
    try {
      const g=pipeGeometry(normalizePipe(o)),b=g.bounds;
      pipeEnvelopes.set(o,{radius:g.outerRadius,bounds:[[b.minx,b.maxx],[b.miny,b.maxy],[b.minz,b.maxz]]});
    } catch { /* 原自检负责无效数据 */ }
  }
  const push = (arc,other) => { const key=[...arc.ids].sort().join('|')+'|'+other; if (!seen.has(key)) { seen.add(key); risks.push({ids:arc.ids,other}); } };
  for (const arc of plan.bends) {
    const steps = Math.ceil(arc.angle/(Math.PI/36)), sagitta = arc.radius*(1-Math.cos(arc.angle/steps/2));
    const r = arc.outerRadius+sagitta, lift = arc.type === 'tray' ? arc.height/2 : 0;
    const points = Array.from({length:steps+1},(_,i) => { const p=arcPoint(arc,i/steps); p[2]+=lift; return p; });
    const segments = points.slice(1).map((p,i) => segmentObject(points[i],p));
    const bounds=boundsOf(points,r);
    envelopes.push({arc,segments,r,bounds});
    if (points.some(p => p[2]+r > roomH || p[2]-r < -floorH || p[2]-r < 0 && p[2]+r > -30)) push(arc,'__space');
    for (const o of objects) {
      if (arc.ids.includes(o.id)) continue;
      const pipe=pipeEnvelopes.get(o);
      if (o.type === 'pipe' && (!pipe || !boundsOverlap(bounds,pipe.bounds))) continue;
      const hit = segments.some(s => {
        if (pipe) return segmentDistance3D(s,o) < r+pipe.radius;
        return deviceDistance(s,o,resolve,floorH,roomH) < r;
      });
      if (hit) push(arc,o.id);
      if (risks.length >= 100) return risks;
    }
  }
  for (let i=0;i<envelopes.length;i++) for (let j=i+1;j<envelopes.length;j++) {
    const a=envelopes[i],b=envelopes[j];
    if (a.arc.ids.some(id=>b.arc.ids.includes(id)) || !boundsOverlap(a.bounds,b.bounds)) continue;
    if (a.segments.some(s=>b.segments.some(t=>segmentDistance3D(s,t)<a.r+b.r))) push(a.arc,b.arc.ids.join(' / '));
    if (risks.length >= 100) return risks;
  }
  return risks;
}
