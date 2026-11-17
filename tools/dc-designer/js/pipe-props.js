/** 管道属性面板及工作平面设置，所有编辑事务复用 normalizePipe。 */
import { state, runtime, ui, notePropEdit, defaultProps, deleteObject } from './state.js';

import { pipeGeometry, pipeColor, PIPE_PRESETS, reversePipe, normalizePipe as createValidation } from './pipe-geometry.js';

import { pipeSettings, setPipeSettings, createPipeSegments, editPipe, pipeRiser } from './pipe-tools.js';

import { t } from './i18n.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;'
}[c]));

const row = (label, body) => `<label class="pr"><span>${esc(label)}</span>${body}</label>`;

const field = (key, v, numeric = false, attr = 'data-pipe') => `<input ${attr}="${esc(key)}" type="${numeric ? 'number' : 'text'}" ${numeric ? 'step="any"' : ''} value="${esc(v)}" dir="ltr">`;

const choice = (key, v, options, attr = 'data-pipe') => `<select ${attr}="${key}">${options.map(k => `<option value="${k}" ${v === k ? 'selected' : ''}>${esc(t('pipe.' + k))}</option>`).join('')}</select>`;

const btn = (action, label) => `<button data-pipe-action="${action}">${esc(t('pipe.' + label))}</button>`;

export function pipePanelHtml(o) {
  const c = pipeSettings(), p = o?.props || defaultProps('pipe');
  let h = `<h3>${t('type.pipe')}</h3><h4>${t('pipe.work')}</h4>`;
  h += row(t('pipe.elevation'), field('elevation', c.elevation, true, 'data-pipe-work'));
  h += row(t('pipe.pair'), `<input data-pipe-work="pair" type="checkbox" ${c.pair ? 'checked' : ''}>`);
  if (c.pair) {
    h += row(t('pipe.spacing'), choice('spacingMode', c.spacingMode, [ 'gap', 'center' ], 'data-pipe-work')) + row(t('pipe.distance'), field('gap', c.gap, true, 'data-pipe-work')) + row(t('pipe.returnElevation'), field('returnElevation', c.returnElevation ?? c.elevation, true, 'data-pipe-work'));
    const r = {
      ...defaultProps('pipe'),
      color: '',
      ...c.returnProps
    };
    for (const k of [ 'outsideDiameter', 'wallThickness', 'insulationThickness', 'color' ]) h += row(t('pipe.return') + ' · ' + t('pipe.' + k), field('returnProps.' + k, r[k], k !== 'color', 'data-pipe-work'));
  }
  h += row(t('pipe.filter'), choice('filter', c.filter, [ 'all', 'elevation', 'system' ], 'data-pipe-work'));
  if (c.filter === 'elevation') h += row(t('pipe.band'), field('band', c.band, true, 'data-pipe-work'));
  h += row(t('pipe.systemId'), field('systemId', c.systemId, false, 'data-pipe-work')) + row(t('pipe.circuitId'), field('circuitId', c.circuitId, false, 'data-pipe-work'));
  h += `<h4>${t('pipe.spec')}</h4>`;
  h += row(t('pipe.preset'), `<select data-pipe-preset><option value="">${t('pipe.custom')}</option>${PIPE_PRESETS.map((v, i) => `<option value="${i}">${v.label}</option>`).join('')}</select>`);
  for (const k of [ 'name', 'nominalSize', 'outsideDiameter', 'wallThickness', 'insulationThickness', 'material' ]) h += row(t(k === 'name' ? 'f.name' : 'pipe.' + k), field('props.' + k, p[k], [ 'outsideDiameter', 'wallThickness', 'insulationThickness' ].includes(k)));
  h += `<h4>${t('pipe.appearance')}</h4>` + row(t('pipe.color'), `<input type="color" data-pipe-color value="${pipeColor({
    props: p
  }, state.project.meta)}">`) + row('HEX', field('props.color', p.color)) + `<div class="pbtns">${[ '#2f6fb2', '#c64634', '#7f44b2', '#2e9e6e', '#64748b' ].map(c => `<button data-pipe-swatch="${c}" style="border-bottom:4px solid ${c}">${c}</button>`).join('')}${btn('auto', 'auto')}</div>`;
  h += `<h4>${t('pipe.systemInfo')}</h4>`;
  for (const [k, opts] of Object.entries({
    side: [ 'supply', 'return' ],
    loopSide: [ 'primary', 'secondary' ],
    flowDirection: [ 'forward', 'reverse', 'none' ]
  })) h += row(t('pipe.' + k), choice('props.' + k, p[k], opts));
  if (o) for (const k of [ 'systemId', 'circuitId', 'pairId' ]) h += row(t('pipe.' + k), k === 'pairId' ? `<span>${esc(o[k] || '—')}</span>` : field(k, o[k]));
  h += row(t('f.remark'), field('props.remark', p.remark));
  h += `<h4>${t('pipe.endpoints')}</h4>`;
  const a = runtime.drawing?.last || {
    x: 0,
    y: 0,
    z: +c.elevation
  };
  for (const i of [ 1, 2 ]) for (const axis of [ 'x', 'y', 'z' ]) h += row(`${axis.toUpperCase()}${i} (mm)`, field(axis + i, o?.[axis + i] ?? (i === 2 && axis === 'x' ? a.x + 1e3 : a[axis]), true));
  if (o) {
    const g = pipeGeometry(o);
    h += row(t('pipe.length'), `<b>${g.length.toFixed(2)} mm</b>`) + row(t('pipe.projection'), `<span>${g.projectionLength.toFixed(2)} mm</span>`) + row(t('pipe.slope'), `<span>${g.slope === null ? '—' : g.slope.toFixed(2) + ' ‰'}</span>`) + row(t('pipe.outer'), `<span>${g.outerDiameter} mm · ${t('pipe.' + g.kind)}</span>`) + row(t('pipe.envelope'), `<span>${g.bounds.minz.toFixed(1)} … ${g.bounds.maxz.toFixed(1)} mm</span>`);
    h += `<div class="pbtns">${btn('swap', 'swap')}${btn('continue', 'continue')}${btn('brush', 'brush')}${btn('delete', 'delete')}</div>` + row(t('pipe.shift'), `<input data-pipe-offset type="number" step="any" value="100">`) + `<div class="pbtns">${btn('shift', 'shift')}${btn('level', 'level')}</div>`;
  } else h += `<div class="pbtns">${btn('create', 'create')}</div>`;
  h += row(t('pipe.endpoint'), `<select data-pipe-end><option value="1">A</option><option value="2" selected>B</option></select>`) + row(t('pipe.target'), `<input data-pipe-target type="number" step="any" value="${o ? o.z2 + 1e3 : a.z + 1e3}">`) + `<div class="pbtns">${btn('riser', 'riser')}</div>` + `<div class="tip"><p>${t('pipe.help')}</p><p>${t('pipe.legend')}</p></div>`;
  return h;
}

export function bindPipePanel(panel, o, setTool) {
  panel.classList.add('pipe-panel');
  const readNumber = el => {
    if (el.value.trim() === '' || !Number.isFinite(Number(el.value))) throw new Error(t('pipe.invalid'));
    return Number(el.value);
  };
  const fail = err => {
    ui.hint(err.message || t('pipe.invalid'));
    ui.props();
  };
  const update = patch => {
    try {
      const normalized = createValidation({
        ...o || {
          x1: 0,
          y1: 0,
          z1: 0,
          x2: 1,
          y2: 0,
          z2: 0
        },
        ...patch,
        props: {
          ...o?.props || defaultProps('pipe'),
          ...patch.props
        }
      });
      if (o) {
        editPipe(o, normalized);
        if (patch.props) for (const k of Object.keys(patch.props)) notePropEdit('pipe', k, normalized.props[k]);
      } else if (patch.props) {
        for (const k of Object.keys(patch.props)) notePropEdit('pipe', k, normalized.props[k]);
        ui.props();
      }
    } catch (e) {
      fail(e);
    }
  };
  // 工作面板默认规格也交叉验证，端点批量表单在「创建」前统一验证。
  panel.querySelectorAll('[data-pipe]').forEach(el => el.addEventListener('change', () => {
    const key = el.dataset.pipe, v = el.type === 'number' ? el.value === '' ? null : Number(el.value) : el.value;
    if (!o && (!key.startsWith('props.') || key==='props.name' || key==='props.remark')) return;
    const patch = key.startsWith('props.') ? {
      props: {
        [key.slice(6)]: v
      }
    } : {
      [key]: v
    };
    if (!o) {
      try {
        const sample = {
          x1: 0,
          y1: 0,
          z1: 0,
          x2: 1,
          y2: 0,
          z2: 0,
          props: {
            ...defaultProps('pipe'),
            ...patch.props
          }
        };
        // 同一验证层：不让非法默认值污染后续创建。
        createValidation(sample);
      } catch (e) {
        fail(e);
        return;
      }
    }
    update(patch);
  }));
  panel.querySelectorAll('[data-pipe-work]').forEach(el => el.addEventListener('change', () => {
    try {
      const key = el.dataset.pipeWork, v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? key === 'returnProps.wallThickness' && el.value === '' ? null : readNumber(el) : el.value;
      if (key.startsWith('returnProps.')) setPipeSettings({
        returnProps: {
          ...defaultProps('pipe'),
          ...pipeSettings().returnProps,
          [key.slice(12)]: v
        }
      }); else setPipeSettings({
        [key]: v
      });
    } catch (e) {
      fail(e);
    }
  }));
  panel.querySelector('[data-pipe-color]').addEventListener('change', e => update({
    props: {
      color: e.target.value
    }
  }));
  panel.querySelectorAll('[data-pipe-swatch]').forEach(el => el.onclick = () => update({
    props: {
      color: el.dataset.pipeSwatch
    }
  }));
  panel.querySelector('[data-pipe-preset]').onchange = e => {
    if (e.target.value !== '') {
      const {label: label, ...props} = PIPE_PRESETS[+e.target.value];
      update({
        props: props
      });
    }
  };
  panel.querySelectorAll('[data-pipe-action]').forEach(el => el.onclick = () => {
    try {
      const action = el.dataset.pipeAction;
      if (action === 'auto') update({
        props: {
          color: ''
        }
      });
      if (action === 'swap') editPipe(o, reversePipe(o));
      if (action === 'shift') {
        const dz = readNumber(panel.querySelector('[data-pipe-offset]'));
        editPipe(o, {
          z1: o.z1 + dz,
          z2: o.z2 + dz
        });
      }
      if (action === 'level') editPipe(o, {
        z1: +pipeSettings().elevation,
        z2: +pipeSettings().elevation
      });
      if (action === 'continue') {
        setTool('pipe');
        runtime.drawing = {
          last: {
            x: o.x2,
            y: o.y2,
            z: o.z2
          },
          lastPipeId: o.id,
          typed: ''
        };
        ui.render();
        ui.props();
      }
      if (action === 'delete') deleteObject(o.id);
      if (action === 'brush') setTool('brush');
      if (action === 'riser') {
        const end = panel.querySelector('[data-pipe-end]').value;
        const from = o ? {
          x: o['x' + end],
          y: o['y' + end],
          z: o['z' + end]
        } : runtime.drawing?.last;
        pipeRiser(readNumber(panel.querySelector('[data-pipe-target]')), from, o);
      }
      if (action === 'create') {
        const q = {};
        for (const axis of [ 'x', 'y', 'z' ]) for (const i of [ 1, 2 ]) q[axis + i] = readNumber(panel.querySelector(`[data-pipe="${axis + i}"]`));
        const props={...defaultProps('pipe')};
        for(const el of panel.querySelectorAll('[data-pipe^="props."]')){
          const k=el.dataset.pipe.slice(6);props[k]=el.type==='number'?(k==='wallThickness'&&el.value===''?null:readNumber(el)):el.value;
        }
        createPipeSegments({
          x: q.x1,
          y: q.y1,
          z: q.z1
        }, {
          x: q.x2,
          y: q.y2,
          z: q.z2
        }, {props,name:props.name});
      }
    } catch (e) {
      fail(e);
    }
  });
}
