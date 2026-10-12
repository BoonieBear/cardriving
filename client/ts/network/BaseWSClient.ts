/**
 * WebSocket 客户端基类
 * 处理连接、重连、消息收发、心跳
 */
import type { ServerToClientMessage, ConnectState } from '../../../shared/protocol.js';

export abstract class BaseWSClient {
  protected ws: WebSocket | null = null;
  protected connectState: ConnectState = 'disconnected';
  protected reconnectAttempts = 0;
  protected maxReconnectAttempts = 5;
  protected reconnectDelay = 2000;
  protected heartbeatInterval: number | null = null;
  protected messageHandlers: Map<string, ((data: any) => void)[]> = new Map();
  protected stateChangeListeners: ((state: ConnectState) => void)[] = [];

  constructor(protected url: string) {}

  /**
   * 连接 WebSocket
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.setState('connecting');
      console.log(`[WS] 正在连接: ${this.url}`);

      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        this.setState('error');
        reject(e);
        return;
      }

      this.ws.onopen = () => {
        console.log('[WS] 连接成功');
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.startHeartbeat();
        this.onConnected();
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleRawMessage(event.data);
      };

      this.ws.onerror = (error) => {
        console.error('[WS] 连接错误', error);
        this.setState('error');
      };

      this.ws.onclose = (event) => {
        console.log(`[WS] 连接关闭: code=${event.code}, reason=${event.reason}`);
        this.stopHeartbeat();
        this.setState('closed');
        this.onDisconnected(event.code, event.reason);

        // 自动重连（非主动关闭）
        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      };
    });
  }

  /**
   * 主动断开
   */
  disconnect(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.setState('disconnected');
  }

  /**
   * 发送消息
   */
  send(data: object): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(data));
    return true;
  }

  /**
   * 注册消息处理器
   */
  onMessage(type: string, handler: (data: any) => void): void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, []);
    }
    this.messageHandlers.get(type)!.push(handler);
  }

  /**
   * 监听连接状态变化
   */
  onStateChange(listener: (state: ConnectState) => void): void {
    this.stateChangeListeners.push(listener);
  }

  /**
   * 获取当前连接状态
   */
  getState(): ConnectState {
    return this.connectState;
  }

  // ========== 子类可重写 ==========
  protected onConnected(): void {}
  protected onDisconnected(code: number, reason: string): void {}
  protected onPacket(packet: object): void {}

  // ========== 内部方法 ==========

  private handleRawMessage(raw: string): void {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // 判断是否为带 type 的控制消息
    if (data && typeof data.type === 'string') {
      const handlers = this.messageHandlers.get(data.type);
      if (handlers) {
        for (const h of handlers) h(data);
      }
      // 特殊处理
      if (data.type === 'heartbeat') {
        // 心跳回显已由服务器处理
      }
    } else {
      // 高频数据包（无 type）
      this.onPacket(data);
    }
  }

  private setState(state: ConnectState): void {
    this.connectState = state;
    for (const listener of this.stateChangeListeners) {
      listener(state);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = window.setInterval(() => {
      this.send({ type: 'heartbeat', timestamp: Date.now() });
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
    console.log(`[WS] ${delay / 1000}秒后尝试重连 (第${this.reconnectAttempts}次)`);
    setTimeout(() => {
      if (this.connectState === 'closed' || this.connectState === 'error') {
        this.connect().catch(() => {});
      }
    }, delay);
  }
}
