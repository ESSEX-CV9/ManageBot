// src/core/types.ts
// 项目通用类型。

import type {
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

/**
 * 一个斜杠命令模块需要导出的形状。
 * 每个命令文件默认导出一个满足该接口的对象。
 */
export interface Command {
    /** 命令定义（不同的 Builder 变体取决于是否添加了子命令/选项） */
    data:
        | SlashCommandBuilder
        | SlashCommandOptionsOnlyBuilder
        | SlashCommandSubcommandsOnlyBuilder;
    /** 命令被调用时执行 */
    execute(interaction: ChatInputCommandInteraction): Promise<unknown>;
    /** 可选：自动补全处理 */
    autocomplete?(interaction: AutocompleteInteraction): Promise<unknown>;
}
