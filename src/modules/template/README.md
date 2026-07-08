# 模版模块（template）

这是一个**可直接复制**的模块骨架，演示了一个 Discord 功能模块会用到的所有核心接入点。
开发新模块时，复制本目录、改名、按需删减即可。（TypeScript）

## 目录结构

```
template/
├── index.ts                       # 模块出口：汇总启动函数、事件/交互 handler
├── commands/
│   └── templateCommand.ts         # 斜杠命令示例（/模版 面板 | /模版 我的计数）
├── components/
│   └── templateComponents.ts      # 按钮面板 + 按钮处理 + 模态框(Modal)处理
├── events/
│   └── messageCreate.ts           # messageCreate 事件处理示例
├── services/
│   ├── templateScheduler.ts       # 后台定时任务（startXxx 模式）
│   └── templateDatabase.ts        # 模块独立数据层（SQLite 示例）
└── README.md
```

## 五个核心接入点

| 能力 | 本模块示例 | 在核心的接入位置 |
| --- | --- | --- |
| 斜杠命令 | `commands/templateCommand.ts` | `src/core/index.ts` 里 `import` 并 `client.commands.set(...)` |
| 按钮 / 选择菜单 | `components/templateComponents.ts` → `handleTemplateButton` | `src/core/events/interactionCreate.ts` 按 `customId` 前缀分发 |
| 模态框 Modal | `components/templateComponents.ts` → `handleTemplateModalSubmit` | 同上（`isModalSubmit()` 分支） |
| 消息事件 | `events/messageCreate.ts` → `templateMessageCreateHandler` | `src/core/events/messageCreate.ts` 聚合调用 |
| 后台定时任务 | `services/templateScheduler.ts` → `startTemplateScheduler` | `src/core/index.ts` 的 `ClientReady` 里调用 `startTemplateSystem` |

## customId 约定

本模块所有交互组件的 `customId` 统一以 **`template_`** 前缀开头。
核心的 `interactionCreate.ts` 依据前缀把交互路由到对应模块——**新模块请换成自己的唯一前缀**，即可与其它模块互不冲突。

## 命令导出约定

每个命令文件**默认导出**一个满足 `Command` 接口（`src/core/types.ts`）的对象：

```ts
import type { Command } from '../../../core/types';
const command: Command = { data, async execute(interaction) { /* ... */ } };
export default command;
```

## 新建一个模块的步骤

1. 复制 `src/modules/template` 为 `src/modules/<yourModule>`，把文件名/前缀/命令名换成你自己的。
2. 在 `src/core/index.ts`：
   - `import` 你的命令并 `client.commands.set(cmd.data.name, cmd)`；
   - `import` 你的 `startXxxSystem` 并在 `ClientReady` 回调里调用；
   - 如需事件/交互，`import` 对应 handler。
3. 在 `src/core/events/interactionCreate.ts` 增加你的 `customId` 前缀分发分支。
4. 若需要监听消息，在 `src/core/events/messageCreate.ts` 增加一行聚合调用。
5. `npm run dev` 启动验证。

## 数据存储建议

- 模块的数据请放在**自己的** `services/*Database.ts` 内（本模块用了独立的 `data/template.sqlite`）。
- 只有真正“通用/跨模块”的设置才考虑用 `core/utils/database.ts` 的通用 KV（`getGuildSetting/saveGuildSetting`）。
- 不要把模块专用的表/字段写回核心，保持核心通用、可复用。
