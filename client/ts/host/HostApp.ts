/**
 * 大屏主机端应用入口
 * 整合 WebSocket、游戏引擎、UI 管理
 */
import { HostClient } from '../network/HostClient.js';
import { GameEngine } from '../core/GameEngine.js';
import { HostUI } from '../ui/HostUI.js';
import { DRIVE_MODES, isDriveMode, type DriveMode } from '../car/AutoPilot.js';
import type { ControlPacket, StatePacket } from '../../../shared/protocol.js';

export class HostApp {
  private client: HostClient;
  private engine: GameEngine;
  private ui: HostUI;

  // 状态同步节流（15帧/秒）
  private lastStateSendTime: number = 0;
  private readonly stateSendInterval: number = 1000 / 15;

  // 本地键盘调试输入
  private keyboardInput: ControlPacket = {
    steer: 0,
    throttle: 0,
    brake: 0,
    gear: 1,
  };
  private keysPressed: Set<string> = new Set();
  private useKeyboardInput: boolean = false; // 无控制器连接时启用键盘调试

  constructor() {
    this.ui = new HostUI();
    this.client = new HostClient();
    this.engine = new GameEngine(document.getElementById('canvas-container')!);
  }

  async init(): Promise<void> {
    console.log('[HostApp] 初始化大屏主机端...');

    // 显示 UI
    this.ui.show();

    // 连接 WebSocket
    try {
      await this.client.connect();
    } catch (e) {
      console.error('[HostApp] WebSocket 连接失败', e);
      // 连接失败也继续运行（本地键盘模式）
    }

    // 注册 UI 回调
    this.ui.onApplySecret((secret: string) => {
      this.client.createRoom(secret);
      this.ui.setSecret(secret);
    });

    // 房间创建成功后更新二维码
    this.client.onMessage('room_created', (data: any) => {
      this.ui.setRoomCode(data.roomCode);
      this.ui.updateQRCode(data.roomCode, data.secret);
    });

    this.client.onDeviceStatus((connected: boolean, deviceName?: string) => {
      this.ui.setConnectionState(connected, deviceName);
      if (connected) {
        // 控制器回来了：结束接管，交还控制权给玩家
        this.engine.exitDisconnectTakeover();
        this.useKeyboardInput = false;
      } else {
        // 控制器断开：切换为全自动驾驶接管，车辆继续沿赛道行驶
        this.engine.enterDisconnectTakeover();
        this.ui.showDisconnectToast();
        this.useKeyboardInput = true; // 断开后允许键盘调试
      }
    });

    this.client.onControlPacket((packet: ControlPacket) => {
      this.engine.setInput(packet);
    });

    // 手机端远程切换驾驶模式
    this.client.onDriveModeRequest((mode: DriveMode) => {
      this.engine.setDriveMode(mode);
    });

    // 驾驶模式：UI 按钮 + 键盘
    this.ui.onDriveModeChange((mode: DriveMode) => {
      this.engine.setDriveMode(mode);
    });

    this.ui.setDriveMode(this.engine.getDriveMode());
    this.engine.onDriveModeChange((mode: DriveMode) => {
      this.ui.showDriveModeToast(mode);
      // 同步到手机端仪表盘
      this.client.sendDriveMode(mode);
    });

    // 注册游戏引擎回调
    this.engine.onFpsUpdate((fps: number) => {
      this.ui.setFps(fps);
    });

    this.engine.onStateUpdate((state: StatePacket) => {
      // 节流发送状态到控制器
      const now = performance.now();
      if (now - this.lastStateSendTime >= this.stateSendInterval) {
        this.lastStateSendTime = now;
        this.client.sendState(state);
      }

      // 更新调试面板
      if (this.ui.isDebugMode()) {
        const input = this.engine.getCurrentInput();
        const carState = this.engine.getCarPhysics().state;
        this.ui.updateDebugData({
          speed: state.speed,
          gear: state.currentGear,
          steer: input.steer,
          throttle: input.throttle,
          brake: input.brake,
          isDrifting: state.isDrifting,
          slipAngle: carState.slipAngle,
          driftIntensity: carState.driftIntensity,
          driveMode: this.engine.getDriveMode(),
          cameraMode: this.engine.getCameraMode(),
        });
      }
    });

    // 初始化键盘调试
    this.initKeyboardDebug();

    // 如果没有控制器连接，默认启用键盘输入
    this.useKeyboardInput = true;

    // 启动游戏循环
    this.engine.start();

    // 不再自动创建房间 — 用户手动输入密钥后点击"创建/更新"
    // 预填一个建议密钥，用户可修改
    this.ui.setSecretInput('1234');

    console.log('[HostApp] 大屏主机端初始化完成');
    console.log('[HostApp] 提示：按 F12 切换开发者调试面板');
    console.log('[HostApp] 提示：按 C 键循环切换相机视角（车内 / 车尾 / 俯视）');
    console.log('[HostApp] 键盘调试：W/↑ 油门，S/↓ 刹车，A/← 左转，D/→ 右转');
  }

  /**
   * 初始化键盘调试（无手机时可用键盘测试）
   */
  private initKeyboardDebug(): void {
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();

      // M 键：循环切换驾驶模式（手动 → 辅助驾驶 → 全自动驾驶）
      if (key === 'm') {
        this.engine.cycleDriveMode();
        return;
      }

      // 数字键 0/1/2：直接切到指定模式
      if (key === '0' || key === '1' || key === '2') {
        const target = DRIVE_MODES[Number(key)];
        if (target) {
          this.engine.setDriveMode(target);
          return;
        }
      }

      // C 键：循环切换相机视角（车内 → 车尾 → 俯视）
      if (key === 'c') {
        const mode = this.engine.cycleCameraView();
        this.ui.showCameraToast(mode);
        return;
      }

      this.keysPressed.add(key);
      this.updateKeyboardInput();
    });

    window.addEventListener('keyup', (e) => {
      this.keysPressed.delete(e.key.toLowerCase());
      this.updateKeyboardInput();
    });

    // 键盘输入轮询（每帧更新到引擎）
    const keyboardLoop = () => {
      if (this.useKeyboardInput) {
        this.engine.setInput({ ...this.keyboardInput });
      }
      requestAnimationFrame(keyboardLoop);
    };
    keyboardLoop();
  }

  private updateKeyboardInput(): void {
    const keys = this.keysPressed;

    // 转向
    let steer = 0;
    if (keys.has('a') || keys.has('arrowleft')) steer -= 1;
    if (keys.has('d') || keys.has('arrowright')) steer += 1;
    this.keyboardInput.steer = steer;

    // 油门
    this.keyboardInput.throttle =
      keys.has('w') || keys.has('arrowup') ? 1 : 0;

    // 刹车
    this.keyboardInput.brake =
      keys.has('s') || keys.has('arrowdown') ? 1 : 0;
  }
}
