// 全局类型增强：给 discord.js 的 Client 加上 commands 集合。
// 顶部的 import 让本文件成为“模块”，从而下面的 declare module 是对 discord.js 的“增强(合并)”
// 而非“替换”——既保留 discord.js 原有全部导出，又给 Client 补上 commands。
import type { Collection } from 'discord.js';
import type { Command } from './core/types';

declare module 'discord.js' {
    interface Client {
        commands: Collection<string, Command>;
    }
}
