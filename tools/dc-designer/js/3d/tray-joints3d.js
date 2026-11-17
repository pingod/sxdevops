/** 展示级水平桥架圆弯：底网/双侧网/四边丝/色带按真实弧长扫掠。 */
import * as THREE from '../../lib/three/three.webgpu.min.js';
import { routeSamples, sampleStepLength } from './route-joints3d.js';
import { worldPoint } from './sweep3d.js';
import { M, S, rep, meshTrayTex } from './materials3d.js';
import { isBim3D, themeColor } from './theme3d.js';
const COLORS = { '强电':0xc0392b, '弱电':0x2980b9, '光纤':0x27ae60 };

function ribbon(samples,e,side0,z0,side1,z1,reverse=false) {
  const pos=[],uv=[],idx=[],lengths=[0,0];
  for(let i=0;i<samples.length;i++) {
    const {p,t}=samples[i], sides=[[side0,z0],[side1,z1]];
    for(let j=0;j<2;j++) {
      const [side,z]=sides[j],point=worldPoint([p[0]-t[1]*side,p[1]+t[0]*side,p[2]+z]);
      if(i)lengths[j]+=sampleStepLength(samples[i-1],samples[i],side);
      pos.push(...point.toArray());
      // 每个物理边按自己的弧长平铺；跨半弧接缝保持相位，反向线段保持横向纹理方向。
      const transverse=side0===side1?z:side*(e.texSign||1);
      uv.push(((e.texStart||0)+(e.texSide||0)*side+(e.texSign||1)*lengths[j])/100,transverse/100);
    }
    if(i){const a=(i-1)*2;reverse ? idx.push(a,a+1,a+2,a+1,a+3,a+2) : idx.push(a,a+2,a+1,a+1,a+2,a+3);}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();g.computeBoundingSphere();return g;
}
export function buildCurvedTray(group,o,e,ceilH) {
  const samples=routeSamples(e),w=e.width,bh=e.height,hh=e.a[2];
  const wireMat=M.steel;
  const meshMat=new THREE.MeshStandardMaterial(isBim3D() ? {
    color:0x94a0ab,roughness:.45,metalness:.25,side:THREE.DoubleSide
  } : {map:rep(meshTrayTex,1,1),alphaTest:.2,roughness:.4,metalness:.85,side:THREE.DoubleSide});
  const stripeMat=new THREE.MeshStandardMaterial({color:themeColor(COLORS[o.props.kind]||0x8e44ad),roughness:.6,metalness:.3,side:THREE.DoubleSide});
  const add=(mat,s0,z0,s1,z1,reverse=false)=>{const m=new THREE.Mesh(ribbon(samples,e,s0,z0,s1,z1,reverse),mat);m.receiveShadow=true;group.add(m);};
  for(const side of [-w/2+3,w/2-3]) {
    add(meshMat,side,3,side,bh-3);
    for(const z of [0,bh-6]) {
      // 四个独立平面保留方形边丝棱角，避免对整个槽截面平滑法线导致塑料观感。
      add(wireMat,side-3,z,side+3,z,true);add(wireMat,side+3,z,side+3,z+6,true);
      add(wireMat,side+3,z+6,side-3,z+6,true);add(wireMat,side-3,z+6,side-3,z,true);
    }
  }
  add(meshMat,-w/2+3,3,w/2-3,3);
  const stH=Math.min(Math.max(bh*.2,10),30);
  for(const side of [-w/2-2.5,w/2+2.5])add(stripeMat,side,bh-stH,side,bh);
  // 吊杆仅放在裁短后直段中，避免伸进转角通道；间距和原直槽一致。
  const dx=o.x2-o.x1,dy=o.y2-o.y1,L=Math.hypot(dx,dy);
  for(let t=600;t<L && ceilH>hh+60;t+=2400) {
    if(t<e.trims[0]+60 || t>L-e.trims[1]-60)continue;
    const rod=new THREE.Mesh(new THREE.CylinderGeometry(5*S,5*S,(ceilH-hh)*S,8),M.steel);
    rod.position.set((o.x1+dx*t/L)*S,(hh+(ceilH-hh)/2)*S,-(o.y1+dy*t/L)*S);group.add(rod);
  }
}
