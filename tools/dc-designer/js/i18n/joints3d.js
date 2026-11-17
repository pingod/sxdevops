/** 展示级圆弯四语言文案。 */
const dictionaries = {
  'zh-CN': {
    title:'平滑接头', enabled:'启用 3D 圆弯', pipeRadius:'管道中心线半径 (mm)', trayInnerRadius:'桥架内弯半径 (mm)',
    help:'管道填 0 为自动（按实际外径/保温外包）。仅处理已接上的同规格两段；不修复双管断口，不生成三通或变径。只影响 3D/3D PNG，JSON、2D、CSV、DXF 与原自检仍按直段。半径不是管件标准。',
    stats:'弯头 {bends} · 保留原状 {skipped} · 弯曲区风险 {risks}', off:'已关闭：显示原始直段',
    risks:'弯曲区风险为采样外扩包络的保守提示（最多 100 条），不是施工碰撞结论。',
    branch:'分支/多重连接', mismatch:'规格/系统/颜色不一致', angle:'转向角不支持（仅 5°～150°）', radius:'半径不足以容纳截面', short:'直段不足以容纳两端弯头',
    space:'地板/结构空间', invalid:'半径需为 0～10000 mm 的有限数字',
  },
  en: {
    title:'Smooth joints', enabled:'Enable 3D elbows', pipeRadius:'Pipe centreline radius (mm)', trayInnerRadius:'Tray inner radius (mm)',
    help:'Pipe 0 = automatic (actual OD/insulation). Only compatible joined pairs; no repair of pair gaps, tees or reducers. Only 3D/3D PNG changes; JSON, 2D, CSV, DXF and original checks remain straight segments. Radii are not fitting standards.',
    stats:'Elbows {bends} · Unchanged {skipped} · Bend risks {risks}', off:'Off: original straight segments',
    risks:'Bend risks use conservatively expanded sampled envelopes (up to 100), not construction collision conclusions.',
    branch:'Branch/ambiguous junction', mismatch:'Specification/system/colour mismatch', angle:'Unsupported turn (5°–150° only)', radius:'Radius too small for section', short:'Segment too short for end bends',
    space:'Floor/structural space', invalid:'Radius must be a finite number from 0 to 10000 mm',
  },
  es: {
    title:'Uniones suaves', enabled:'Activar codos 3D', pipeRadius:'Radio central de tubería (mm)', trayInnerRadius:'Radio interior de bandeja (mm)',
    help:'Tubería 0 = automático (diámetro real/aislamiento). Solo pares compatibles conectados; no repara huecos ni crea tes o reductores. Solo cambia 3D/PNG 3D; JSON, 2D, CSV, DXF y comprobaciones originales siguen rectos. No son radios normativos.',
    stats:'Codos {bends} · Sin cambio {skipped} · Riesgos {risks}', off:'Desactivado: segmentos originales',
    risks:'Riesgos conservadores por envolventes muestreadas ampliadas (máximo 100); no son conclusiones de colisión para obra.',
    branch:'Ramal/unión ambigua', mismatch:'Especificación/sistema/color distinto', angle:'Giro no admitido (solo 5°–150°)', radius:'Radio insuficiente para la sección', short:'Tramo insuficiente para los codos',
    space:'Suelo/espacio estructural', invalid:'El radio debe ser un número finito de 0 a 10000 mm',
  },
  ar: {
    title:'وصلات ناعمة', enabled:'تفعيل أكواع ثلاثية الأبعاد', pipeRadius:'نصف قطر محور الأنبوب (مم)', trayInnerRadius:'نصف القطر الداخلي للحامل (مم)',
    help:'قيمة الأنبوب 0 = تلقائي حسب القطر الفعلي والعزل. للأزواج المتصلة المتوافقة فقط؛ لا إصلاح للفجوات أو إنشاء تفرعات أو مخفضات. يتغير العرض ثلاثي الأبعاد وصورته فقط؛ تبقى البيانات والتصديرات والفحوص الأصلية مستقيمة. ليست أبعاد تجهيزات معيارية.',
    stats:'أكواع {bends} · دون تغيير {skipped} · مخاطر {risks}', off:'معطّل: المقاطع المستقيمة الأصلية',
    risks:'تنبيهات محافظة بأغلفة عينات موسعة (حتى 100)، وليست نتائج تصادم إنشائية.',
    branch:'تفرع/وصلة ملتبسة', mismatch:'اختلاف المواصفات/النظام/اللون', angle:'زاوية غير مدعومة (5°–150° فقط)', radius:'نصف القطر أصغر من المقطع', short:'المقطع أقصر من مساحة الأكواع',
    space:'الأرضية/المساحة الإنشائية', invalid:'يجب أن يكون نصف القطر رقماً منتهياً بين 0 و10000 مم',
  },
};
export const jointDicts = Object.fromEntries(Object.entries(dictionaries).map(([locale,dict]) =>
  [locale,Object.fromEntries(Object.entries(dict).map(([k,v]) => ['joints3d.'+k,v]))]));
