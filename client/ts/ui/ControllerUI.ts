/**
 * 手机控制器端 UI 管理
 * 负责连接面板、机械仪表盘（方向盘 / 挡位闸）、状态显示
 */
import type { StatePacket, ConnectState } from '../../../shared/protocol.js';
import { steerToWheelDegrees, steerToDisplayDegrees, signedDegreesText, gearToText } from '../controller/ControlMapping.js';
import { DRIVE_MODE_LABELS, type DriveMode } from '../car/AutoPilot.js';

export class ControllerUI {
  private connPanel: HTMLElement;
  private dashboard: HTMLElement;
  private connRoomCode: HTMLInputElement;
  private connSecret: HTMLInputElement;
  private connError: HTMLElement;
  private btnConnect: HTMLButtonElement;
  private btnCalibrate: HTMLButtonElement;

  // 仪表盘元素
  private connectDot: HTMLElement;
  private connectText: HTMLElement;
  private speedValue: HTMLElement;
  private gearValue: HTMLElement;
  private driftIndicator: HTMLElement;
  private steerWheel: HTMLElement;
  private steerValueText: HTMLElement;
  private driveModeBadge: HTMLElement;

  private driveMode: DriveMode = 'manual';

  // 回调
  private connectCallback: ((roomCode: string, secret: string) => void) | null = null;
  private calibrateCallback: (() => void) | null = null;

  constructor() {
    this.connPanel = document.getElementById('conn-panel')!;
    this.dashboard = document.getElementById('dashboard')!;
    this.connRoomCode = document.getElementById('conn-room-code') as HTMLInputElement;
    this.connSecret = document.getElementById('conn-secret') as HTMLInputElement;
    this.connError = document.getElementById('conn-error')!;
    this.btnConnect = document.getElementById('btn-connect') as HTMLButtonElement;
    this.btnCalibrate = document.getElementById('btn-calibrate') as HTMLButtonElement;

    this.connectDot = document.getElementById('dash-connect-dot')!;
    this.connectText = document.getElementById('dash-connect-text')!;
    this.speedValue = document.getElementById('dash-speed-value')!;
    this.gearValue = document.getElementById('dash-gear-value')!;
    this.driftIndicator = document.getElementById('dash-drift-indicator')!;
    this.steerWheel = document.getElementById('steer-pointer')!;
    this.steerValueText = document.getElementById('steer-value-text')!;
    this.driveModeBadge = document.getElementById('dash-drive-mode')!;

    // 连接按钮
    this.btnConnect.addEventListener('click', () => {
      const roomCode = this.connRoomCode.value.trim();
      const secret = this.connSecret.value.trim();
      if (this.connectCallback) {
        this.connectCallback(roomCode, secret);
      }
    });

    // 校准按钮
    this.btnCalibrate.addEventListener('click', () => {
      if (this.calibrateCallback) {
        this.calibrateCallback();
      }
    });

    // 房间码输入限制为数字
    this.connRoomCode.addEventListener('input', () => {
      this.connRoomCode.value = this.connRoomCode.value.replace(/\D/g, '').slice(0, 6);
    });
  }

  /**
   * 显示控制器 UI
   */
  show(): void {
    document.getElementById('controller-ui')!.classList.remove('hidden');
  }

  /**
   * 显示连接面板
   */
  showConnPanel(): void {
    this.connPanel.classList.remove('hidden');
    this.dashboard.classList.add('hidden');
  }

  /**
   * 显示仪表盘（连接成功后）
   */
  showDashboard(): void {
    this.connPanel.classList.add('hidden');
    this.dashboard.classList.remove('hidden');
  }

  /**
   * 预填房间码（二维码扫码连接用）
   */
  setRoomCode(code: string): void {
    this.connRoomCode.value = code;
  }

  /**
   * 预填密钥（二维码扫码连接用）
   */
  setSecret(secret: string): void {
    this.connSecret.value = secret;
  }

  /**
   * 显示连接错误
   */
  showError(message: string): void {
    this.connError.textContent = message;
    this.connError.classList.remove('hidden');
  }

  /**
   * 隐藏错误
   */
  hideError(): void {
    this.connError.classList.add('hidden');
  }

  /**
   * 设置连接按钮状态
   */
  setConnectButtonState(loading: boolean, text?: string): void {
    this.btnConnect.disabled = loading;
    if (text) this.btnConnect.textContent = text;
    else if (loading) this.btnConnect.textContent = '连接中...';
    else this.btnConnect.textContent = '连接';
  }

  /**
   * 更新驾驶模式显示（顶部徽标 + 按钮高亮 + 仪表盘状态类）
   */
  setDriveMode(mode: DriveMode): void {
    this.driveMode = mode;

    if (this.driveModeBadge) {
      this.driveModeBadge.textContent = DRIVE_MODE_LABELS[mode];
      this.driveModeBadge.dataset.mode = mode;
      this.driveModeBadge.classList.toggle('hidden', mode === 'manual');
    }

    // 按钮高亮
    document.querySelectorAll('.ctrl-drive-mode-btn').forEach(btn => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset.mode === mode);
    });

    // 仪表盘整体状态（用于自动模式下的视觉提示）
    this.dashboard.dataset.driveMode = mode;
    this.dashboard.classList.toggle('autonomous', mode !== 'manual');
  }

  getDriveMode(): DriveMode {
    return this.driveMode;
  }

  /**
   * 更新游戏状态显示
   */
  updateState(state: StatePacket): void {
    this.speedValue.textContent = Math.round(state.speed).toString();
    this.gearValue.textContent = gearToText(state.currentGear);

    if (state.isDrifting) {
      this.driftIndicator.classList.remove('hidden');
      this.dashboard.classList.add('drifting');
    } else {
      this.driftIndicator.classList.add('hidden');
      this.dashboard.classList.remove('drifting');
    }

    // 驾驶模式以服务端为准（大屏可能用键盘 M 键切换）
    // 旧版状态包没有该字段，此时保持当前模式不变
    if (state.driveMode && state.driveMode !== this.driveMode) {
      this.setDriveMode(state.driveMode);
    }

    this.updateConnectState(state.connectState);
  }

  /**
   * 更新连接状态显示
   */
  updateConnectState(state: ConnectState): void {
    switch (state) {
      case 'connected':
        this.connectDot.className = 'connect-dot connected';
        this.connectText.textContent = '已连接';
        break;
      case 'connecting':
        this.connectDot.className = 'connect-dot disconnected';
        this.connectText.textContent = '连接中';
        break;
      default:
        this.connectDot.className = 'connect-dot disconnected';
        this.connectText.textContent = '未连接';
        break;
    }
  }

  /**
   * 更新方向盘转角与读数
   * @param steer [-1, 1]
   */
  updateSteerIndicator(steer: number): void {
    // 方向盘跟着陀螺仪倾角转动（满舵 ±120°），前轮转角另外用小字显示
    this.steerWheel.style.transform = `rotate(${steerToWheelDegrees(steer)}deg)`;
    this.steerValueText.textContent = signedDegreesText(steerToDisplayDegrees(steer));
  }

  /**
   * 注册连接回调
   */
  onConnect(callback: (roomCode: string, secret: string) => void): void {
    this.connectCallback = callback;
  }

  /**
   * 注册校准回调
   */
  onCalibrate(callback: () => void): void {
    this.calibrateCallback = callback;
  }

  /**
   * 获取输入的房间码和密钥
   */
  getInput(): { roomCode: string; secret: string } {
    return {
      roomCode: this.connRoomCode.value.trim(),
      secret: this.connSecret.value.trim(),
    };
  }
}
