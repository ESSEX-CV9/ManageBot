// src/modules/template/index.ts
//
// 模块统一出口（barrel）。
// 约定：每个模块都在 index.ts 汇总对外暴露的东西，核心只 import 这一个文件即可接入模块的
//   - 启动函数（startXxxSystem）
//   - 事件 handler（供 core/events/* 聚合调用）
//   - 交互 handler（供 core/events/interactionCreate.ts 分发）
// 命令(commands/*)通常仍由 core/index.ts 单独 import 并注册进 client.commands。

import type { Client } from 'discord.js';
import { startTemplateScheduler } from './services/templateScheduler';

export { templateMessageCreateHandler } from './events/messageCreate';
export { handleTemplateButton, handleTemplateModalSubmit } from './components/templateComponents';

/**
 * 启动模版系统（在 clientReady 后由核心调用）。
 */
export async function startTemplateSystem(client: Client): Promise<void> {
    startTemplateScheduler(client);
    console.log('🧩 模版模块已加载');
}
