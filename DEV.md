# DEV

## 测试约定

**本项目所有代码更改必须附带测试。**

- 测试框架：Vitest 2.x + jsdom
- 测试文件：与源码同目录，命名 `*.test.ts`
- 运行全部测试：`npm test`
- 监听模式：`npm run test:watch`
- 配置文件：`vitest.config.ts`

### 测试覆盖要求

每次修改代码时，必须为以下内容编写或更新测试：

1. **新增功能** — 至少 1 个正向用例 + 1 个边界/异常用例
2. **Bug 修复** — 必须写回归测试（复现 bug 的用例，修复后通过）
3. **重构** — 确保已有测试全部通过，行为不变
4. **数学/物理逻辑** — 关键公式必须有数值断言

### Canvas/DOM 测试

客户端渲染代码使用 jsdom + mock CanvasRenderingContext2D。
参考 `client/ts/core/Pseudo3DRenderer.test.ts` 中的 `createMockCtx()` 和 `createRenderer()` 模式。

### 示例

```bash
npm test            # 运行全部测试
npx vitest run      # 同上
npx vitest          # 监听模式
```
