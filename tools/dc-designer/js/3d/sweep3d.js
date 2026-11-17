/** 沿采样路径扫掠圆截面，解析切向法线；相邻对象的弯头截面完全对齐。 */
import * as THREE from '../../lib/three/three.webgpu.min.js';
const S = .001;
export const worldPoint = p => new THREE.Vector3(p[0]*S,p[2]*S,-p[1]*S);
const worldVector = p => new THREE.Vector3(p[0],p[2],-p[1]);

export function sweepTube(samples, radius, radial = 24, caps = [false,false]) {
  const positions=[], normals=[], uvs=[], indices=[], rings=[];
  let previous=null, previousT=null, length=0;
  const step=2*Math.PI/radial;
  for (let i=0;i<samples.length;i++) {
    const s=samples[i], p=worldPoint(s.p), t=worldVector(s.t).normalize();
    let n=s.n ? worldVector(s.n).normalize() : null;
    const transported=previous ? previous.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(previousT,t)) : null;
    if (!n && !previous) {
      const next=samples.find(v=>v.n);
      if(next)n=worldVector(next.n).normalize();
    }
    if (!n) n=transported || new THREE.Vector3(Math.abs(t.y)<.9?0:1,Math.abs(t.y)<.9?1:0,0).cross(t).normalize();
    n.addScaledVector(t,-n.dot(t)).normalize();
    // 允许整格换相位（同一组截面顶点），避免直段接两个不同弯曲平面时网格大角度扭转。
    if (transported) {
      const angle=Math.atan2(t.dot(new THREE.Vector3().crossVectors(n,transported)),n.dot(transported));
      n.applyAxisAngle(t,Math.round(angle/step)*step);
    }
    const b=new THREE.Vector3().crossVectors(t,n).normalize();
    if (i) length+=p.distanceTo(rings.at(-1).p);
    rings.push({p,t,n,b}); previous=n; previousT=t;
    for (let j=0;j<=radial;j++) {
      const q=j*step, normal=n.clone().multiplyScalar(Math.cos(q)).addScaledVector(b,Math.sin(q));
      positions.push(...p.clone().addScaledVector(normal,radius*S).toArray());
      normals.push(...normal.toArray()); uvs.push(j/radial,length);
      if (i && j<radial) {
        const a=(i-1)*(radial+1)+j,c=i*(radial+1)+j;
        indices.push(a,a+1,c,a+1,c+1,c);
      }
    }
  }
  for (const [end,enabled] of caps.entries()) if (enabled) {
    const ring=rings[end?rings.length-1:0], normal=ring.t.clone().multiplyScalar(end?1:-1), base=positions.length/3;
    positions.push(...ring.p.toArray());normals.push(...normal.toArray());uvs.push(.5,.5);
    for(let j=0;j<=radial;j++) {
      const q=j*step,p=ring.p.clone().addScaledVector(ring.n,Math.cos(q)*radius*S).addScaledVector(ring.b,Math.sin(q)*radius*S);
      positions.push(...p.toArray());normals.push(...normal.toArray());uvs.push(.5+Math.cos(q)/2,.5+Math.sin(q)/2);
      if(j<radial) end ? indices.push(base,base+j+1,base+j+2) : indices.push(base,base+j+2,base+j+1);
    }
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setIndex(indices);g.computeBoundingSphere();
  return g;
}
