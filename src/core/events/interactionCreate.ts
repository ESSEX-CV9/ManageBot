// src/core/events/interactionCreate.ts
//
// 统一的交互分发器。处理四类交互：
//   1. 斜杠命令 / 上下文菜单 / 自动补全  → 通过 client.commands 分发
//   2. 按钮(Button)                      → 按 customId 前缀分发到对应模块
//   3. 模态框(ModalSubmit)               → 按 customId 前缀分发到对应模块
//   4. 选择菜单(SelectMenu)              → 按 customId 前缀分发到对应模块
//
// 接入新模块的交互：在下方对应分支按你的 customId 前缀增加一个 if 分支即可。

import { MessageFlags, type Interaction, type ChatInputCommandInteraction } from 'discord.js';

// 模版模块的交互 handler（新模块仿照此处 import 自己的 handler）
import { handleTemplateButton, handleTemplateModalSubmit } from '../../modules/template';
// 募选模块的交互 handler
import { handleElectionButton, handleElectionSelect, handleElectionModal } from '../../modules/election';
// 标题规范模块的交互 handler
import {
    handleTitleGuardButton,
    handleTitleGuardSelect,
    handleTitleGuardModal,
    handleAuthorFixButton,
} from '../../modules/titleGuard';

const INTERACTION_DEBUG_LOG = String(process.env.INTERACTION_DEBUG_LOG || '').toLowerCase() === 'true';

export async function interactionCreateHandler(interaction: Interaction): Promise<void> {
    try {
        if (INTERACTION_DEBUG_LOG) {
            const gid = interaction.guild?.id || 'dm';
            const uid = interaction.user?.id || 'unknown';
            if (interaction.isChatInputCommand()) {
                console.log(`[Interaction][cmd] ${interaction.commandName} guild=${gid} user=${uid}`);
            } else if (interaction.isButton()) {
                console.log(`[Interaction][button] ${interaction.customId} guild=${gid} user=${uid}`);
            } else if (interaction.isAnySelectMenu()) {
                console.log(`[Interaction][select] ${interaction.customId} guild=${gid} user=${uid}`);
            } else if (interaction.isModalSubmit()) {
                console.log(`[Interaction][modal] ${interaction.customId} guild=${gid} user=${uid}`);
            }
        }

        // 1a. 自动补全
        if (interaction.isAutocomplete()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command || typeof command.autocomplete !== 'function') return;
            try {
                await command.autocomplete(interaction);
            } catch (error) {
                console.error('自动补全时出错:', error);
            }
            return;
        }

        // 1b. 斜杠命令
        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                console.warn(`[Interaction] ⚠️ 未找到命令处理器: ${interaction.commandName}`);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ 该命令在当前机器人版本中未加载或已被移除。请联系管理员重新同步命令。',
                        flags: MessageFlags.Ephemeral,
                    }).catch(() => {});
                }
                return;
            }
            await command.execute(interaction);
            return;
        }

        // 1c. 上下文菜单（右键命令）
        if (interaction.isMessageContextMenuCommand() || interaction.isUserContextMenuCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ 该指令在当前机器人版本中未加载或已被移除。',
                        flags: MessageFlags.Ephemeral,
                    }).catch(() => {});
                }
                return;
            }
            // 当前无右键命令；如需接入可在命令内自行区分交互类型
            await command.execute(interaction as unknown as ChatInputCommandInteraction);
            return;
        }

        // 2. 按钮
        if (interaction.isButton()) {
            if (interaction.customId.startsWith('template_')) {
                await handleTemplateButton(interaction);
            } else if (interaction.customId.startsWith('elect_')) {
                await handleElectionButton(interaction);
            } else if (interaction.customId.startsWith('tt_')) {
                // 作者自助面板里的按钮先接，剩下的交给通知面板
                if (!(await handleAuthorFixButton(interaction))) {
                    await handleTitleGuardButton(interaction);
                }
            }
            // 新模块：在此追加 else if (customId.startsWith('yourprefix_')) { ... }
            return;
        }

        // 3. 模态框提交
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('template_')) {
                await handleTemplateModalSubmit(interaction);
            } else if (interaction.customId.startsWith('elect_')) {
                await handleElectionModal(interaction);
            } else if (interaction.customId.startsWith('tt_')) {
                await handleTitleGuardModal(interaction);
            }
            // 新模块：在此追加分支
            return;
        }

        // 4. 选择菜单（String/Role/Channel 等所有 SelectMenu）
        if (interaction.isAnySelectMenu()) {
            if (interaction.customId.startsWith('elect_')) {
                await handleElectionSelect(interaction);
            } else if (interaction.customId.startsWith('tt_')) {
                await handleTitleGuardSelect(interaction);
            }
            // 新模块：在此追加 if (customId.startsWith('yourprefix_')) { ... }
            return;
        }
    } catch (error) {
        console.error('交互处理错误:', error);
        try {
            if (interaction.isRepliable()) {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '处理您的请求时出现错误。',
                        flags: MessageFlags.Ephemeral,
                    });
                } else if (interaction.deferred) {
                    await interaction.editReply({ content: '处理您的请求时出现错误。' });
                }
            }
        } catch (replyError) {
            console.error('回复错误:', replyError);
        }
    }
}
