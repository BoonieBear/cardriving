/**
 * 手机控制器端应用入口
 * 整合 WebSocket、陀螺仪、触控、UI
 */
import { ControllerClient } from '../network/ControllerClient.js';
import { Gyroscope } from './Gyroscope.js';
import { TouchControls } from './TouchControls.js';
import { Haptics } from './Haptics.js';
import { gearToText } from './ControlMapping.js';
import { ControllerUI } from '../ui/ControllerUI.js';
import type { DriveMode } from '../car/AutoPilot.js';
import type { ControlPacket, StatePacket } from '../../../shared/protocol.js';

export class ControllerApp {
  private client: ControllerClient;
  private gyroscope: Gyroscope;
  private touchControls: TouchControls;
  private ui: ControllerUI;
  private haptics: Haptics;

  // 操控包发送循环
  private sendLoopId: number = 0;
  private readonly sendInterval: number = 1000 / 30; // 30帧/秒
  private lastSendTime: number = 0;

  // 当前挡位（用户手动选择）
  private currentGear: number = 1;

  // 当前驾驶模式（本机 UI 状态，实际运算始终在大屏端）
  private driveMode: DriveMode = 'manual';

  constructor() {
    this.ui = new ControllerUI();
    this.client = new ControllerClient();
    this.gyroscope = new Gyroscope();
    this.haptics = new Haptics();
    this.touchControls = new TouchControls(
      'btn-brake',
      'btn-throttle',
      'brake-bar-fill',
      'throttle-bar-fill',
      this.haptics,
    );
    this.bindGearButtons();
    this.bindDriveModeButtons();
  }

  /**
   * 绑定驾驶模式按钮（手动 / 辅助驾驶 / 全自动驾驶）
   * 点击后向大屏发送切换请求；所有自动驾驶运算都在大屏端执行。
   */
  private bindDriveModeButtons(): void {
    document.querySelectorAll('.ctrl-drive-mode-btn').forEach(btn => {
      const mode = (btn as HTMLElement).dataset.mode as DriveMode | undefined;
      if (!mode) return;
      btn.addEventListener('click', () => {
        if (mode === this.driveMode) return;
        // 模式切换给一次触觉反馈
        this.haptics.gearShift(mode === 'manual' ? 0 : 1);
        this.setDriveMode(mode);
        this.client.sendDriveMode(mode);
      });
    });
  }

  /**
   * 更新本机模式显示（不发送网络请求，用于同步大屏状态）
   */
  private setDriveMode(mode: DriveMode): void {
    this.driveMode = mode;
    this.ui.setDriveMode(mode);
  }

  /**
   * 绑定手动挡按钮（入挡时给一次机械顿挫反馈）
   */
  private bindGearButtons(): void {
    document.querySelectorAll('.gear-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const gear = parseInt((btn as HTMLElement).dataset.gear || '1', 10);
        if (gear === this.currentGear) return;
        this.currentGear = gear;
        // 入挡手感
        this.haptics.gearShift(gear);
        // 更新按钮高亮
        document.querySelectorAll('.gear-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // 更新仪表盘显示
        const gearEl = document.getElementById('dash-gear-value');
        if (gearEl) gearEl.textContent = gearToText(gear);
      });
    });
  }

  async init(preFill?: { room?: string; secret?: string }): Promise<void> {
    console.log('[ControllerApp] 初始化手机控制器端...');

    this.ui.show();
    this.ui.showConnPanel();

    // 如果有 URL 参数预填，自动填入并尝试连接
    if (preFill?.room) {
      this.ui.setRoomCode(preFill.room);
    }
    if (preFill?.secret) {
      this.ui.setSecret(preFill.secret);
    }
    if (preFill?.room && preFill?.secret) {
      // 预填了完整信息，延迟自动连接（等UI渲染）
      setTimeout(() => {
        this.handleConnect(preFill.room!, preFill.secret!);
      }, 300);
    }

    // 注册 UI 回调
    this.ui.onConnect((roomCode: string, secret: string) => {
      this.handleConnect(roomCode, secret);
    });

    this.ui.onCalibrate(() => {
      this.gyroscope.calibrate();
      this.haptics.calibrateDone();
    });

    // 注册 WebSocket 状态回调
    this.client.onStatePacket((state: StatePacket) => {
      // updateState 内部会同步 driveMode（大屏可能用键盘切换）
      this.ui.updateState(state);
      this.driveMode = this.ui.getDriveMode();
      // 档位由用户手动选择，不从服务端同步
    });

    // 大屏主动推送的模式变更
    this.client.onDriveMode((mode: DriveMode) => {
      this.setDriveMode(mode);
    });

    this.client.onStateChange((state) => {
      this.ui.updateConnectState(state);
      if (state === 'closed' || state === 'disconnected') {
        // 连接断开，回到连接面板
        this.stopSendLoop();
        this.touchControls.reset();
        setTimeout(() => {
          this.ui.showConnPanel();
          this.ui.setConnectButtonState(false);
        }, 1000);
      }
    });

    // 启动转向指示器更新循环
    this.startSteerIndicatorLoop();

    console.log('[ControllerApp] 手机控制器端初始化完成');
  }

  /**
   * 处理连接请求
   */
  private async handleConnect(roomCode: string, secret: string): Promise<void> {
    // 输入校验
    if (!/^\d{6}$/.test(roomCode)) {
      this.ui.showError('请输入6位数字房间码');
      return;
    }
    if (!secret) {
      this.ui.showError('请输入房间密钥');
      return;
    }

    this.ui.hideError();
    this.ui.setConnectButtonState(true, '连接中...');

    try {
      // 1. 先请求陀螺仪权限（必须在用户点击手势的调用栈中，iOS 限制）
      const permissionOk = await this.gyroscope.requestPermission();
      if (!permissionOk) {
        this.ui.showError('陀螺仪权限被拒绝，请在浏览器设置中允许');
        this.ui.setConnectButtonState(false);
        return;
      }

      // 2. 连接 WebSocket
      await this.client.connect();

      // 3. 启动陀螺仪
      const gyroStarted = this.gyroscope.start();
      if (!gyroStarted) {
        console.warn('[ControllerApp] 陀螺仪启动失败，将仅使用触控');
      }

      // 4. 加入房间
      const success = await this.client.joinRoom(roomCode, secret);
      if (!success) {
        const errorMsg = this.client.getLastError() || '加入房间失败';
        this.ui.showError(errorMsg);
        this.ui.setConnectButtonState(false);
        this.gyroscope.stop();
        return;
      }

      // 5. 成功：显示仪表盘，启动操控包发送
      this.ui.showDashboard();
      this.ui.setConnectButtonState(false);
      this.gyroscope.calibrate(); // 自动校准一次
      this.startSendLoop();

      console.log('[ControllerApp] 已连接到房间，开始发送操控数据');
    } catch (e) {
      console.error('[ControllerApp] 连接失败', e);
      this.ui.showError('连接服务器失败，请检查网络或服务器地址');
      this.ui.setConnectButtonState(false);
    }
  }

  /**
   * 启动操控数据包发送循环（30帧/秒）
   */
  private startSendLoop(): void {
    this.stopSendLoop();
    this.lastSendTime = performance.now();

    const loop = () => {
      this.sendLoopId = requestAnimationFrame(loop);

      const now = performance.now();
      if (now - this.lastSendTime >= this.sendInterval) {
        this.lastSendTime = now;
        this.sendControlPacket();
      }
    };
    loop();
  }

  /**
   * 停止发送循环
   */
  private stopSendLoop(): void {
    if (this.sendLoopId) {
      cancelAnimationFrame(this.sendLoopId);
      this.sendLoopId = 0;
    }
  }

  /**
   * 发送操控数据包
   */
  private sendControlPacket(): void {
    const steer = this.gyroscope.getSteer();

    const packet: ControlPacket = {
      steer,
      throttle: this.touchControls.getThrottle(),
      brake: this.touchControls.getBrake(),
      gear: this.currentGear,
    };

    this.client.sendControl(packet);
  }

  /**
   * 转向指示器更新循环
   */
  private startSteerIndicatorLoop(): void {
    const loop = () => {
      requestAnimationFrame(loop);
      const steer = this.gyroscope.getSteer();
      this.ui.updateSteerIndicator(steer);
    };
    loop();
  }
}
