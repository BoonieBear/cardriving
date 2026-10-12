/**
 * 大屏主机端 UI 管理
 * 负责房间面板、帧率显示、开发者调试面板、断线提示、连接二维码
 */
import QRCode from 'qrcode';
import {
  DRIVE_MODES,
  DRIVE_MODE_LABELS,
  type DriveMode,
} from '../car/AutoPilot.js';
import { CAMERA_MODE_LABELS, type CameraMode } from '../core/Software3DRenderer.js';

export class HostUI {
  // DOM 元素引用
  private roomPanel: HTMLElement;
  private roomCodeDisplay: HTMLElement;
  private roomSecretInput: HTMLInputElement;
  private btnApplySecret: HTMLButtonElement;
  private connectionState: HTMLElement;
  private fpsDisplay: HTMLElement;
  private debugPanel: HTMLElement;
  private disconnectToast: HTMLElement;
  private qrCanvas: HTMLCanvasElement;
  private qrContainer: HTMLElement;
  private qrUrlText: HTMLElement;

  // 驾驶模式 UI
  private driveModeBar: HTMLElement;
  private driveModeToast: HTMLElement;
  private modeButtons: HTMLButtonElement[] = [];
  private driveMode: DriveMode = 'manual';

  // 调试面板元素
  private debugRoomCode: HTMLElement;
  private debugSecret: HTMLElement;
  private debugConnectState: HTMLElement;
  private debugDeviceCount: HTMLElement;
  private debugFps: HTMLElement;
  private debugSpeed: HTMLElement;
  private debugGear: HTMLElement;
  private debugSteer: HTMLElement;
  private debugThrottle: HTMLElement;
  private debugBrake: HTMLElement;
  private debugDrift: HTMLElement;
  private debugSlip: HTMLElement;
  private debugDriftIntensity: HTMLElement;
  private debugDriveMode: HTMLElement;
  private debugCamera: HTMLElement;

  // 视角切换提示
  private cameraToast: HTMLElement;

  private debugMode: boolean = false;

  // 回调
  private applySecretCallback: ((secret: string) => void) | null = null;
  private driveModeCallback: ((mode: DriveMode) => void) | null = null;

  constructor() {
    this.roomPanel = document.getElementById('room-panel')!;
    this.roomCodeDisplay = document.getElementById('room-code-display')!;
    this.roomSecretInput = document.getElementById('room-secret-input') as HTMLInputElement;
    this.btnApplySecret = document.getElementById('btn-apply-secret') as HTMLButtonElement;
    this.connectionState = document.getElementById('room-connection-state')!;
    this.fpsDisplay = document.getElementById('fps-display')!;
    this.debugPanel = document.getElementById('debug-panel')!;
    this.disconnectToast = document.getElementById('disconnect-toast')!;
    this.qrCanvas = document.getElementById('qr-canvas') as HTMLCanvasElement;
    this.qrContainer = document.getElementById('qr-container')!;
    this.qrUrlText = document.getElementById('qr-url-text')!;

    this.driveModeBar = document.getElementById('drive-mode-bar')!;
    this.driveModeToast = document.getElementById('drive-mode-toast')!;

    this.debugRoomCode = document.getElementById('debug-room-code')!;
    this.debugSecret = document.getElementById('debug-secret')!;
    this.debugConnectState = document.getElementById('debug-connect-state')!;
    this.debugDeviceCount = document.getElementById('debug-device-count')!;
    this.debugFps = document.getElementById('debug-fps')!;
    this.debugSpeed = document.getElementById('debug-speed')!;
    this.debugGear = document.getElementById('debug-gear')!;
    this.debugSteer = document.getElementById('debug-steer')!;
    this.debugThrottle = document.getElementById('debug-throttle')!;
    this.debugBrake = document.getElementById('debug-brake')!;
    this.debugDrift = document.getElementById('debug-drift')!;
    this.debugSlip = document.getElementById('debug-slip')!;
    this.debugDriftIntensity = document.getElementById('debug-drift-intensity')!;
    this.debugDriveMode = document.getElementById('debug-drive-mode')!;
    this.debugCamera = document.getElementById('debug-camera')!;

    this.cameraToast = document.getElementById('camera-toast')!;

    this.initDriveModeButtons();

    // 绑定事件
    this.btnApplySecret.addEventListener('click', () => {
      const secret = this.roomSecretInput.value.trim();
      if (secret && this.applySecretCallback) {
        this.applySecretCallback(secret);
      }
    });

    // 回车提交密钥
    this.roomSecretInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.btnApplySecret.click();
      }
    });

    // F12 切换开发者模式
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F12') {
        e.preventDefault();
        this.toggleDebugMode();
      }
    });
  }

  /**
   * 初始化驾驶模式按钮（手动 / 辅助驾驶 / 全自动驾驶）
   */
  private initDriveModeButtons(): void {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.drive-mode-btn'),
    );
    for (const btn of buttons) {
      const mode = btn.dataset.mode as DriveMode | undefined;
      if (!mode || !DRIVE_MODES.includes(mode)) continue;
      this.modeButtons.push(btn);
      btn.addEventListener('click', () => {
        if (this.driveModeCallback) this.driveModeCallback(mode);
      });
    }
  }

  /**
   * 更新驾驶模式显示（按钮高亮 + 顶部提示 + 调试面板）
   */
  setDriveMode(mode: DriveMode): void {
    this.driveMode = mode;
    for (const btn of this.modeButtons) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }
    if (this.driveModeBar) {
      this.driveModeBar.dataset.mode = mode;
    }
    if (this.debugDriveMode) {
      this.debugDriveMode.textContent = DRIVE_MODE_LABELS[mode];
    }
  }

  getDriveMode(): DriveMode {
    return this.driveMode;
  }

  /**
   * 模式切换时在屏幕中央短暂提示（沉浸模式下也能看到反馈）
   */
  showDriveModeToast(mode: DriveMode): void {
    this.setDriveMode(mode);
    if (!this.driveModeToast) return;
    this.driveModeToast.textContent = DRIVE_MODE_LABELS[mode];
    this.driveModeToast.dataset.mode = mode;
    this.driveModeToast.classList.remove('hidden');
    this.driveModeToast.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.driveModeToast.classList.remove('show');
      this.driveModeToast.classList.add('hidden');
    }, 1600);
  }

  private toastTimer: number = 0;

  onDriveModeChange(callback: (mode: DriveMode) => void): void {
    this.driveModeCallback = callback;
  }

  show(): void {
    document.getElementById('host-ui')!.classList.remove('hidden');
  }

  setRoomCode(code: string): void {
    this.roomCodeDisplay.textContent = code;
    this.debugRoomCode.textContent = code;
  }

  setSecret(secret: string): void {
    this.debugSecret.textContent = secret;
  }

  setConnectionState(connected: boolean, deviceName?: string): void {
    if (connected) {
      this.connectionState.textContent = deviceName ? `已连接: ${deviceName}` : '已连接';
      this.connectionState.className = 'room-connection-state connected';
      this.debugConnectState.textContent = '已连接';
      this.debugDeviceCount.textContent = '1';
      setTimeout(() => this.hideRoomPanel(), 1500);
      this.hideDisconnectToast();
    } else {
      this.connectionState.textContent = '等待控制器';
      this.connectionState.className = 'room-connection-state waiting';
      this.debugConnectState.textContent = '未连接';
      this.debugDeviceCount.textContent = '0';
      this.showRoomPanel();
    }
  }

  hideRoomPanel(): void {
    this.roomPanel.style.display = 'none';
  }

  showRoomPanel(): void {
    this.roomPanel.style.display = 'block';
  }

  setFps(fps: number): void {
    this.fpsDisplay.textContent = `FPS: ${fps}`;
    this.debugFps.textContent = String(fps);
  }

  updateDebugData(data: {
    speed: number;
    gear: number;
    steer: number;
    throttle: number;
    brake: number;
    isDrifting: boolean;
    slipAngle?: number;       // 滑移角（弧度）
    driftIntensity?: number;  // 漂移强度 [0,1]
    driveMode?: DriveMode;
    cameraMode?: CameraMode;
  }): void {
    this.debugSpeed.textContent = `${data.speed.toFixed(1)} km/h`;
    this.debugGear.textContent = String(data.gear);
    this.debugSteer.textContent = data.steer.toFixed(2);
    this.debugThrottle.textContent = data.throttle.toFixed(2);
    this.debugBrake.textContent = data.brake.toFixed(2);
    this.debugDrift.textContent = data.isDrifting ? '是' : '否';
    if (data.slipAngle !== undefined) {
      this.debugSlip.textContent = `${((data.slipAngle * 180) / Math.PI).toFixed(1)}°`;
    }
    if (data.driftIntensity !== undefined) {
      this.debugDriftIntensity.textContent = data.driftIntensity.toFixed(2);
    }
    if (data.driveMode) {
      this.debugDriveMode.textContent = DRIVE_MODE_LABELS[data.driveMode];
    }
    if (data.cameraMode) {
      this.debugCamera.textContent = CAMERA_MODE_LABELS[data.cameraMode];
    }
  }

  /**
   * 视角切换时在屏幕中央短暂提示
   */
  showCameraToast(mode: CameraMode): void {
    if (this.debugCamera) this.debugCamera.textContent = CAMERA_MODE_LABELS[mode];
    if (!this.cameraToast) return;
    this.cameraToast.textContent = CAMERA_MODE_LABELS[mode];
    this.cameraToast.classList.remove('hidden');
    this.cameraToast.classList.add('show');
    window.clearTimeout(this.cameraToastTimer);
    this.cameraToastTimer = window.setTimeout(() => {
      this.cameraToast.classList.remove('show');
      this.cameraToast.classList.add('hidden');
    }, 1400);
  }

  private cameraToastTimer: number = 0;

  toggleDebugMode(): void {
    this.debugMode = !this.debugMode;
    if (this.debugMode) {
      this.debugPanel.classList.remove('hidden');
    } else {
      this.debugPanel.classList.add('hidden');
    }
  }

  showDisconnectToast(): void {
    this.disconnectToast.classList.remove('hidden');
  }

  hideDisconnectToast(): void {
    this.disconnectToast.classList.add('hidden');
  }

  onApplySecret(callback: (secret: string) => void): void {
    this.applySecretCallback = callback;
  }

  setSecretInput(secret: string): void {
    this.roomSecretInput.value = secret;
  }

  isDebugMode(): boolean {
    return this.debugMode;
  }

  /**
   * 更新连接二维码
   * 编码控制器连接 URL（含房间码和密钥），手机扫码即可直接连接
   */
  updateQRCode(roomCode: string, secret: string): void {
    if (!this.qrCanvas) return;

    // 构建控制器 URL：当前页面 origin + mode=controller + room + secret
    const url = `${window.location.origin}${window.location.pathname}?mode=controller&room=${encodeURIComponent(roomCode)}&secret=${encodeURIComponent(secret)}`;

    QRCode.toCanvas(this.qrCanvas, url, {
      width: 160,
      margin: 1,
      color: {
        dark: '#1a1a1a',
        light: '#ffffff',
      },
    }, (err) => {
      if (err) {
        console.error('[UI] 二维码生成失败', err);
        return;
      }
      if (this.qrContainer) {
        this.qrContainer.classList.remove('hidden');
      }
      if (this.qrUrlText) {
        this.qrUrlText.textContent = url;
      }
    });
  }
}
