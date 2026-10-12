/**
 * 6位随机房间码生成
 * 范围：000000 - 999999
 */
/**
 * 生成6位纯数字随机房间码
 */
export function generateRoomCode() {
    const code = Math.floor(Math.random() * 1000000);
    return code.toString().padStart(6, '0');
}
/**
 * 生成指定长度的随机数字字符串
 */
export function generateNumericCode(length) {
    let code = '';
    for (let i = 0; i < length; i++) {
        code += Math.floor(Math.random() * 10).toString();
    }
    return code;
}
/**
 * 校验是否为合法的6位数字房间码
 */
export function isValidRoomCode(code) {
    return /^\d{6}$/.test(code);
}
//# sourceMappingURL=randomCode.js.map