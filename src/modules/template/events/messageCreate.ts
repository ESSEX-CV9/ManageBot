// src/modules/template/events/messageCreate.ts
//
// 模版模块的 messageCreate 事件处理示例。
// 核心会在 src/core/events/messageCreate.ts 里聚合调用各模块的 handler。
// 注意：一定要先忽略机器人自己/其它 bot 的消息，避免死循环或噪音。

import type { Message } from 'discord.js';

export async function templateMessageCreateHandler(message: Message): Promise<void> {
    // 忽略 bot 消息与私信
    if (message.author?.bot) return;
    if (!message.guild) return;

    // 一个极简示例：当有人发送恰好为「模版ping」的消息时给出回应。
    // 真实模块可在此做关键词检测、活跃度统计等（记得控制频率与性能）。
    if (message.content.trim() === '模版ping') {
        await message.reply('模版pong 🏓').catch(() => {});
    }
}
