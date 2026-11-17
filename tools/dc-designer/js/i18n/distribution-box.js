/** 配电箱的四语言文案；按功能独立维护，避免继续扩大基础字典。 */
export const distributionBoxDicts = {
  'zh-CN': {
    'type.dbox': '配电箱', 'auto.dbox': '配电箱',
    'hint.tool.dbox': '配电箱：单击放置（默认 600×200×800），记录用途、安装方式、电压/电流及输出回路；R 旋转，可连续放置',
    'db.use': '配电用途', 'db.power': '动力配电', 'db.lighting': '照明配电', 'db.general': '综合配电', 'db.other': '其他',
    'db.mounting': '安装方式', 'db.wall': '壁挂明装', 'db.recessed': '嵌入暗装', 'db.floor': '落地安装',
    'db.voltage': '额定电压(V)', 'db.current': '额定电流(A)',
    'tip.dbox': '配电箱为独立设备，浅型箱体 + 框内闪电符号，正面色条标识朝向（R 旋转）。记录配电用途、安装方式、额定电压/电流及输出回路配置。壁挂/暗装仅记录安装方式，不自动吸附或切开墙体；请用 X/Y 与 Z坐标·底部标高定位（新建默认 Z=0）。',
  },
  en: {
    'type.dbox': 'Dist. box', 'auto.dbox': 'DB',
    'hint.tool.dbox': 'Distribution box: click to place (600×200×800 mm). Record use, mounting, voltage/current and outgoing circuits; R rotates; repeat to place more.',
    'db.use': 'Distribution use', 'db.power': 'Power', 'db.lighting': 'Lighting', 'db.general': 'General', 'db.other': 'Other',
    'db.mounting': 'Mounting', 'db.wall': 'Wall mounted', 'db.recessed': 'Recessed', 'db.floor': 'Floor standing',
    'db.voltage': 'Rated voltage(V)', 'db.current': 'Rated current(A)',
    'tip.dbox': 'Independent shallow distribution box with a framed lightning symbol and front stripe (R rotates). Record use, mounting, voltage/current and outgoing circuits. Wall/recessed mounting is metadata only: no wall snapping or openings. Position with X/Y and base Z (new boxes start at Z=0).',
  },
  es: {
    'type.dbox': 'C. eléctrico', 'auto.dbox': 'CE',
    'hint.tool.dbox': 'Cuadro eléctrico: clic para colocar (600×200×800 mm). Uso, montaje, tensión/corriente y circuitos de salida; R gira.',
    'db.use': 'Uso eléctrico', 'db.power': 'Potencia', 'db.lighting': 'Alumbrado', 'db.general': 'General', 'db.other': 'Otro',
    'db.mounting': 'Montaje', 'db.wall': 'En pared', 'db.recessed': 'Empotrado', 'db.floor': 'De suelo',
    'db.voltage': 'Tensión nom.(V)', 'db.current': 'Corriente nom.(A)',
    'tip.dbox': 'Cuadro independiente con símbolo de rayo enmarcado y franja frontal (R gira). Registre uso, montaje, tensión/corriente y circuitos. El montaje es informativo: no se ancla ni abre huecos en paredes. Sitúe con X/Y y cota inferior Z (valor inicial 0).',
  },
  ar: {
    'type.dbox': 'لوحة توزيع', 'auto.dbox': 'لوحة توزيع',
    'hint.tool.dbox': 'لوحة توزيع: انقر للوضع (600×200×800 مم). سجّل الاستخدام والتركيب والجهد/التيار ودوائر الخرج؛ R للتدوير.',
    'db.use': 'استخدام التوزيع', 'db.power': 'قدرة', 'db.lighting': 'إنارة', 'db.general': 'عام', 'db.other': 'أخرى',
    'db.mounting': 'طريقة التركيب', 'db.wall': 'على الجدار', 'db.recessed': 'داخل الجدار', 'db.floor': 'أرضي',
    'db.voltage': 'الجهد المقنن(V)', 'db.current': 'التيار المقنن(A)',
    'tip.dbox': 'لوحة توزيع مستقلة ضحلة برمز برق مؤطر وشريط أمامي (R للتدوير). سجّل الاستخدام والتركيب والجهد/التيار ودوائر الخرج. التركيب وصف فقط دون التقاط أو فتح الجدار؛ حدّد الموضع بإحداثيات X/Y ومنسوب القاعدة Z (القيمة الابتدائية 0).',
  },
};
