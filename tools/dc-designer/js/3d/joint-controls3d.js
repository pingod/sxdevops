/** 3D 展示偏好和诊断面板：本机记忆，不写项目、不记撤销。 */
import { normalizeJointOptions } from './route-joints3d.js';
import { t, onLocaleChange } from '../i18n.js';
const KEY='idc2d_joints3d_v1';
let options=normalizeJointOptions(),last=null,apply=()=>{},panel=null;
try { options=normalizeJointOptions(JSON.parse(localStorage.getItem(KEY)||'{}')||{}); } catch { /* 隐私模式/旧值 */ }
export const jointOptions3D=()=>({...options});
export function setJointOptions3D(patch={}) {
  options=normalizeJointOptions({...options,...patch});
  try { localStorage.setItem(KEY,JSON.stringify(options)); } catch { /* 隐私模式 */ }
  sync();apply();return jointOptions3D();
}
export function initJointControls3D(rebuild) {
  apply=rebuild;
  panel=document.getElementById('joints3d-panel');
  const button=document.getElementById('btn-joints3d');
  button?.addEventListener('click',()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));});
  document.getElementById('joints3d-enabled')?.addEventListener('change',e=>setJointOptions3D({enabled:e.target.checked}));
  for(const k of ['pipeRadius','trayInnerRadius'])document.getElementById('joints3d-'+k)?.addEventListener('change',e=>{
    if(e.target.value.trim()==='' || !e.target.checkValidity() || !Number.isFinite(+e.target.value)) {
      e.target.setCustomValidity(t('joints3d.invalid'));e.target.reportValidity();e.target.setCustomValidity('');sync();return;
    }
    setJointOptions3D({[k]:+e.target.value});
  });
  onLocaleChange(()=>updateJointReport3D(last));sync();
}
function sync() {
  const c=document.getElementById('joints3d-enabled');if(c)c.checked=options.enabled;
  for(const k of ['pipeRadius','trayInnerRadius']) { const el=document.getElementById('joints3d-'+k);if(el){el.value=options[k];el.disabled=!options.enabled;} }
  document.getElementById('btn-joints3d')?.classList.toggle('active',options.enabled);
}
export function updateJointReport3D(report) {
  last=report;sync();
  const stat=document.getElementById('joints3d-stats'),details=document.getElementById('joints3d-details');
  if(!stat || !details)return;
  stat.textContent=options.enabled ? t('joints3d.stats',{bends:report?.bends.length||0,skipped:report?.skipped.length||0,risks:report?.risks.length||0}) : t('joints3d.off');
  details.replaceChildren();
  if(!report || !options.enabled)return;
  const counts=new Map();for(const s of report.skipped)counts.set(s.reason,(counts.get(s.reason)||0)+1);
  for(const [reason,count] of counts) {const li=document.createElement('li');li.textContent=t('joints3d.'+reason)+' × '+count;details.append(li);}
  for(const risk of report.risks.slice(0,10)) {
    const li=document.createElement('li');li.textContent=risk.ids.join(' / ')+' → '+(risk.other==='__space'?t('joints3d.space'):risk.other);details.append(li);
  }
}
