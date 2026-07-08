// src/core/events/messageCreate.ts
//
// 聚合各模块的 messageCreate 处理。
// 每个模块的 handler 都用 try/catch 包裹，避免某个模块抛错影响其它模块。
// 接入新模块：import 其 handler 并在下方加一个 try/catch 调用。

import type { Message } from 'discord.js';
import { templateMessageCreateHandler } from '../../modules/template';

export async function messageCreateHandler(message: Message): Promise<void> {
    try {
        await templateMessageCreateHandler(message);
    } catch (error) {
        console.error('处理 template 模块的 messageCreate 事件时出错:', error);
    }
}
