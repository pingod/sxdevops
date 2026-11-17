/**
 * 面板状态总线（左侧工勘向导 ⇄ 合规自检，右侧属性 / AI建模）
 *
 * 左侧向导与自检互斥；右侧 AI 的显隐只同步顶栏状态，不再关闭左栏。
 * `ai-enter` 是显式进入 AI 的一次性通知：默认收起左栏释放画布，之后允许手动并存。
 * 收起方只改自身状态，不引发连锁；面板之间互不 import，避免循环依赖。
 *
 * 另一条通道 `busy`：面板「工作中」（模型往返/指令执行）状态单独广播——顶栏按钮要靠它做
 * 持续呼吸，且**与 open 无关**：面板收起后请求仍在跑，按钮仍应提示「AI 正在作图」。
 */

const EVT = 'idc2d:panel-state';
const BUSY_EVT = 'idc2d:panel-busy';

/** 广播面板状态（name: 'wizard' | 'ai' | 'checks' | 'ai-enter'） */
export function notifyPanelState(name, open) {
  window.dispatchEvent(new CustomEvent(EVT, { detail: { name, open: !!open } }));
}

/** 订阅状态变化（各面板按自身所属区域处理，不再全局三方互斥） */
export function onPanelState(cb) {
  window.addEventListener(EVT, e => cb(e.detail || {}));
}

/** 广播面板工作状态（name: 'ai'，busy: 是否正在模型往返/执行指令） */
export function notifyPanelBusy(name, busy) {
  window.dispatchEvent(new CustomEvent(BUSY_EVT, { detail: { name, busy: !!busy } }));
}

/** 订阅面板工作状态（顶栏 AI 按钮据此持续呼吸，见 agent.js） */
export function onPanelBusy(cb) {
  window.addEventListener(BUSY_EVT, e => cb(e.detail || {}));
}
