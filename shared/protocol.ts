/**
 * 全局通信协议类型定义
 * 所有 WebSocket 消息均遵循此文件定义，禁止增减字段
 */

// ========== 连接状态枚举 ==========
export type ConnectState =
  | 'disconnected'   // 未连接
  | 'connecting'     // 连接中
  | 'connected'      // 已连接
  | 'error'          // 连接错误
  | 'closed';        // 连接关闭

// ========== 手机 → 大屏：操控输入包（30帧/秒）==========
export interface ControlPacket {
  steer: number;     // [-1 ~ 1] 左右转向
  throttle: number;  // [0 ~ 1] 油门力度
  brake: number;     // [0 ~ 1] 刹车力度
  gear: number;      // 挡位编码（-1倒挡、0空挡、1~5前进挡）
}

// ========== 驾驶模式（辅助驾驶 / 全自动驾驶）==========
/**
 * 驾驶模式：
 *  - manual 手动驾驶：完全由玩家操控
 *  - assist 辅助驾驶：系统接管油门/换挡/车道保持/避障，刹车仍归玩家优先
 *  - auto   全自动驾驶：系统全权接管，自动加减速过弯
 *
 * 模式切换走低频控制面消息（带 type），
 * 高频操控包 ControlPacket 结构保持不变。
 */
export type DriveMode = 'manual' | 'assist' | 'auto';

// ========== 大屏 → 手机：状态同步包（15帧/秒）==========
export interface StatePacket {
  speed: number;        // 实时车速 (km/h)
  currentGear: number;  // 当前真实挡位
  isDrifting: boolean;  // 是否处于漂移状态
  connectState: ConnectState; // 连接状态
  driveMode?: DriveMode; // 当前驾驶模式（可选字段，兼容旧包）
}

// ========== 手机 → 大屏：切换驾驶模式请求 ==========
export interface DriveModeRequest {
  type: 'set_drive_mode';
  mode: DriveMode;
}

// ========== 大屏 → 手机：驾驶模式变更通知 ==========
export interface DriveModeNotification {
  type: 'drive_mode';
  mode: DriveMode;
}

// ========== 房间相关消息 ==========

// 大屏创建房间请求
export interface CreateRoomRequest {
  type: 'create_room';
  secret: string;  // 大屏自定义密钥
}

// 房间创建成功响应
export interface CreateRoomResponse {
  type: 'room_created';
  roomCode: string;  // 6位房间码
  secret: string;    // 回显密钥
}

// 手机加入房间请求
export interface JoinRoomRequest {
  type: 'join_room';
  roomCode: string;  // 6位房间码
  secret: string;    // 密钥
  deviceName?: string; // 设备名称（可选）
}

// 加入成功响应
export interface JoinRoomResponse {
  type: 'room_joined';
  roomCode: string;
  success: boolean;
}

// 错误响应
export interface ErrorResponse {
  type: 'error';
  code: string;       // 错误码
  message: string;    // 错误描述
}

// 设备连接状态通知（大屏→手机，或服务器→大屏）
export interface DeviceStatusNotification {
  type: 'device_status';
  connected: boolean;       // 控制器是否已连接
  deviceName?: string;
}

// 心跳包
export interface Heartbeat {
  type: 'heartbeat';
  timestamp: number;
}

// ========== 消息联合类型 ==========
export type ClientToServerMessage =
  | CreateRoomRequest
  | JoinRoomRequest
  | DriveModeRequest
  | ControlPacket
  | Heartbeat;

export type ServerToClientMessage =
  | CreateRoomResponse
  | JoinRoomResponse
  | ErrorResponse
  | StatePacket
  | DriveModeNotification
  | DeviceStatusNotification
  | Heartbeat;

// 注意：ControlPacket 和 StatePacket 没有 type 字段，
// 它们是在房间建立后通过纯 JSON 直接发送的高频数据包，
// 服务器根据连接角色（大屏/手机）进行转发。
// 带有 type 字段的是控制面消息。

// ========== 角色标识 ==========
export type ClientRole = 'host' | 'controller';

// ========== 房间状态 ==========
export interface RoomInfo {
  roomCode: string;
  secret: string;
  hostConnected: boolean;
  controllerConnected: boolean;
  createdAt: number;
}
