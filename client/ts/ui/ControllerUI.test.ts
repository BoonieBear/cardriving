/**
 * @vitest-environment jsdom
 *
 * 控制器 UI 测试
 * 直接加载真实的 client/index.html，保证「标记 ↔ JS」契约不被破坏
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ControllerUI } from './ControllerUI';

// 直接读取真实的页面标记（vitest 的 cwd 为项目根目录）
const INDEX_HTML = readFileSync(resolve(process.cwd(), 'client/index.html'), 'utf8');

function loadRealMarkup(): void {
  const match = INDEX_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!match) throw new Error('index.html 缺少 <body>');
  document.body.innerHTML = match[1];
}

beforeEach(loadRealMarkup);

describe('ControllerUI — 真实标记契约', () => {
  it('index.html 里包含控制器需要的全部元素', () => {
    const ui = new ControllerUI();
    expect(ui).toBeInstanceOf(ControllerUI);

    for (const id of [
      'conn-panel', 'dashboard', 'conn-room-code', 'conn-secret', 'conn-error',
      'btn-connect', 'btn-calibrate', 'dash-connect-dot', 'dash-connect-text',
      'dash-speed-value', 'dash-gear-value', 'dash-drift-indicator',
      'steer-pointer', 'steer-value-text', 'dash-drive-mode',
      'btn-brake', 'btn-throttle', 'brake-bar-fill', 'throttle-bar-fill',
      'brake-readout', 'throttle-readout',
    ]) {
      expect(document.getElementById(id), `缺少 #${id}`).not.toBeNull();
    }

    // 踏板需要行程轨道与踏板面（CSS 机械动画的挂载点）
    for (const sel of ['.pedal-track', '.pedal-thumb', '.pedal-plate']) {
      expect(document.querySelectorAll(sel).length, `缺少 ${sel}`).toBe(2);
    }
    expect(document.querySelectorAll('.gear-btn').length).toBe(7);
    // 驾驶模式按钮：手动 / 辅助驾驶 / 全自动驾驶
    expect(document.querySelectorAll('.ctrl-drive-mode-btn').length).toBe(3);
  });
});

describe('ControllerUI — 驾驶模式', () => {
  let ui: ControllerUI;

  beforeEach(() => {
    ui = new ControllerUI();
  });

  it('默认手动模式：徽标隐藏、手动按钮高亮', () => {
    expect(ui.getDriveMode()).toBe('manual');
    expect(document.getElementById('dash-drive-mode')!.classList.contains('hidden')).toBe(true);
    const manual = document.querySelector('.ctrl-drive-mode-btn[data-mode="manual"]')!;
    expect(manual.classList.contains('active')).toBe(true);
  });

  it('切到辅助驾驶：徽标显示中文名并带 assist 标记', () => {
    ui.setDriveMode('assist');
    const badge = document.getElementById('dash-drive-mode')!;
    expect(ui.getDriveMode()).toBe('assist');
    expect(badge.textContent).toBe('辅助驾驶');
    expect(badge.dataset.mode).toBe('assist');
    expect(badge.classList.contains('hidden')).toBe(false);
  });

  it('切到全自动驾驶：徽标显示并只高亮对应按钮', () => {
    ui.setDriveMode('auto');
    const badge = document.getElementById('dash-drive-mode')!;
    expect(badge.textContent).toBe('全自动驾驶');
    expect(badge.dataset.mode).toBe('auto');
    expect(
      document.querySelector('.ctrl-drive-mode-btn[data-mode="auto"]')!.classList.contains('active'),
    ).toBe(true);
    expect(
      document.querySelector('.ctrl-drive-mode-btn[data-mode="manual"]')!.classList.contains('active'),
    ).toBe(false);
  });

  it('自动驾驶时仪表盘加 autonomous 类，回到手动后移除', () => {
    const dash = document.getElementById('dashboard')!;
    ui.setDriveMode('auto');
    expect(dash.classList.contains('autonomous')).toBe(true);
    expect(dash.dataset.driveMode).toBe('auto');

    ui.setDriveMode('manual');
    expect(dash.classList.contains('autonomous')).toBe(false);
    expect(document.getElementById('dash-drive-mode')!.classList.contains('hidden')).toBe(true);
  });

  it('从状态包同步驾驶模式（大屏用键盘切换时手机跟随）', () => {
    ui.updateState({
      speed: 80, currentGear: 4, isDrifting: false,
      connectState: 'connected', driveMode: 'assist',
    });
    expect(ui.getDriveMode()).toBe('assist');
    expect(document.getElementById('dash-drive-mode')!.dataset.mode).toBe('assist');
  });

  it('状态包缺少 driveMode 字段时沿用当前模式（向后兼容）', () => {
    ui.setDriveMode('auto');
    ui.updateState({ speed: 10, currentGear: 1, isDrifting: false, connectState: 'connected' });
    expect(ui.getDriveMode()).toBe('auto');
  });
});

describe('ControllerUI — 方向盘', () => {
  let ui: ControllerUI;

  beforeEach(() => {
    ui = new ControllerUI();
  });

  it('转向时旋转方向盘而不是平移滑块', () => {
    const wheel = document.getElementById('steer-pointer')!;
    ui.updateSteerIndicator(1);
    expect(wheel.style.transform).toBe('rotate(120deg)');
    expect(wheel.style.left).toBe('');

    ui.updateSteerIndicator(-0.5);
    expect(wheel.style.transform).toBe('rotate(-60deg)');
  });

  it('转角读数带符号且经过四舍五入', () => {
    const text = document.getElementById('steer-value-text')!;
    ui.updateSteerIndicator(0);
    expect(text.textContent).toBe('0°');
    ui.updateSteerIndicator(1);
    expect(text.textContent).toBe('+35°');
    ui.updateSteerIndicator(-1);
    expect(text.textContent).toBe('-35°');
  });

  it('超出范围的输入不会让方向盘转过头', () => {
    const wheel = document.getElementById('steer-pointer')!;
    ui.updateSteerIndicator(9);
    expect(wheel.style.transform).toBe('rotate(120deg)');
    ui.updateSteerIndicator(-9);
    expect(wheel.style.transform).toBe('rotate(-120deg)');
  });
});

describe('ControllerUI — 仪表状态', () => {
  let ui: ControllerUI;

  beforeEach(() => {
    ui = new ControllerUI();
  });

  it('速度与挡位显示', () => {
    ui.updateState({ speed: 123.4, currentGear: 3, isDrifting: false, connectState: 'connected' });
    expect(document.getElementById('dash-speed-value')!.textContent).toBe('123');
    expect(document.getElementById('dash-gear-value')!.textContent).toBe('3');
  });

  it('空挡 / 倒挡文本', () => {
    ui.updateState({ speed: 0, currentGear: 0, isDrifting: false, connectState: 'connected' });
    expect(document.getElementById('dash-gear-value')!.textContent).toBe('N');
    ui.updateState({ speed: 0, currentGear: -1, isDrifting: false, connectState: 'connected' });
    expect(document.getElementById('dash-gear-value')!.textContent).toBe('R');
  });

  it('漂移时点亮指示灯并给面板加抖动类', () => {
    const dash = document.getElementById('dashboard')!;
    const drift = document.getElementById('dash-drift-indicator')!;

    ui.updateState({ speed: 50, currentGear: 2, isDrifting: true, connectState: 'connected' });
    expect(drift.classList.contains('hidden')).toBe(false);
    expect(dash.classList.contains('drifting')).toBe(true);

    ui.updateState({ speed: 50, currentGear: 2, isDrifting: false, connectState: 'connected' });
    expect(drift.classList.contains('hidden')).toBe(true);
    expect(dash.classList.contains('drifting')).toBe(false);
  });

  it('连接状态映射到指示灯样式', () => {
    const dot = document.getElementById('dash-connect-dot')!;
    const text = document.getElementById('dash-connect-text')!;

    ui.updateConnectState('connected');
    expect(dot.className).toContain('connected');
    expect(text.textContent).toBe('已连接');

    ui.updateConnectState('disconnected');
    expect(dot.className).toContain('disconnected');
    expect(text.textContent).toBe('未连接');
  });

  it('房间码输入只保留数字且最多 6 位', () => {
    const input = document.getElementById('conn-room-code') as HTMLInputElement;
    input.value = 'a1b2c3d4e5f6';
    input.dispatchEvent(new Event('input'));
    expect(input.value).toBe('123456');
  });

  it('连接面板与仪表盘互斥显示', () => {
    const panel = document.getElementById('conn-panel')!;
    const dash = document.getElementById('dashboard')!;
    ui.showDashboard();
    expect(panel.classList.contains('hidden')).toBe(true);
    expect(dash.classList.contains('hidden')).toBe(false);
    ui.showConnPanel();
    expect(panel.classList.contains('hidden')).toBe(false);
    expect(dash.classList.contains('hidden')).toBe(true);
  });
});

describe('ControllerUI — 连接回调', () => {
  afterEach(() => vi.restoreAllMocks());

  it('点击连接按钮回传裁剪后的房间码与密钥', () => {
    const ui = new ControllerUI();
    const cb = vi.fn();
    ui.onConnect(cb);

    (document.getElementById('conn-room-code') as HTMLInputElement).value = ' 123456 ';
    (document.getElementById('conn-secret') as HTMLInputElement).value = ' key ';
    document.getElementById('btn-connect')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(cb).toHaveBeenCalledWith('123456', 'key');
  });

  it('点击校准按钮触发校准回调', () => {
    const ui = new ControllerUI();
    const cb = vi.fn();
    ui.onCalibrate(cb);
    document.getElementById('btn-calibrate')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
