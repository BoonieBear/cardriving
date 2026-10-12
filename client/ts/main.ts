/**
 * 应用入口
 * 负责模式选择与初始化（大屏主机 / 手机控制器）
 */

// 检测 URL 参数中的模式
function getModeFromUrl(): 'host' | 'controller' | null {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  if (mode === 'host' || mode === 'controller') return mode;
  return null;
}

// 从 URL 参数获取控制器预填信息（二维码扫码连接用）
function getControllerPreFill(): { room?: string; secret?: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    room: params.get('room') || undefined,
    secret: params.get('secret') || undefined,
  };
}

async function initHostMode() {
  const { HostApp } = await import('./host/HostApp.js');
  const app = new HostApp();
  await app.init();
}

async function initControllerMode() {
  const { ControllerApp } = await import('./controller/ControllerApp.js');
  const app = new ControllerApp();
  const preFill = getControllerPreFill();
  await app.init(preFill);
}

function showModeSelector() {
  const selector = document.getElementById('mode-selector');
  if (selector) selector.classList.remove('hidden');

  const btnHost = document.getElementById('btn-host');
  const btnController = document.getElementById('btn-controller');

  btnHost?.addEventListener('click', () => {
    selector?.classList.add('hidden');
    initHostMode();
  });

  btnController?.addEventListener('click', () => {
    selector?.classList.add('hidden');
    initControllerMode();
  });
}

// 启动
const urlMode = getModeFromUrl();
if (urlMode === 'host') {
  document.getElementById('mode-selector')?.classList.add('hidden');
  initHostMode();
} else if (urlMode === 'controller') {
  document.getElementById('mode-selector')?.classList.add('hidden');
  initControllerMode();
} else {
  showModeSelector();
}
