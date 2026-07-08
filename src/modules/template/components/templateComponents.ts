// src/modules/template/components/templateComponents.ts
//
// 模版模块的交互组件：按钮面板 / 按钮处理 / 模态框(Modal)处理。
//
// customId 命名约定（重要）：
//   - 本模块所有交互 customId 统一以 `template_` 前缀开头。
//   - 核心事件分发器（src/core/events/interactionCreate.ts）据此把交互路由到本模块，
//     不同模块用不同前缀即可互不冲突。

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    type ButtonInteraction,
    type ModalSubmitInteraction,
} from 'discord.js';

import { incrementCounter, setNote, getCounter } from '../services/templateDatabase';

// 本模块用到的 customId 常量，集中管理便于对照分发逻辑
export const IDS = {
    INCREMENT_BUTTON: 'template_increment',
    NOTE_BUTTON: 'template_note',
    NOTE_MODAL: 'template_note_modal',
    NOTE_INPUT: 'template_note_input',
} as const;

/**
 * 构建一个演示用的按钮面板（供 /模版 面板 发送）。
 */
export function buildTemplatePanel(): {
    content: string;
    components: ActionRowBuilder<ButtonBuilder>[];
} {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(IDS.INCREMENT_BUTTON)
            .setLabel('➕ 计数 +1')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(IDS.NOTE_BUTTON)
            .setLabel('✏️ 填写备注')
            .setStyle(ButtonStyle.Secondary),
    );

    return {
        content: '🧩 **模版模块示例面板**\n点击下方按钮体验：按钮交互（计数）与模态框交互（备注）。',
        components: [row],
    };
}

/**
 * 处理本模块的按钮点击。
 * 由 interactionCreate 在 customId 以 `template_` 开头且 isButton() 时调用。
 */
export async function handleTemplateButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guild) return;

    if (interaction.customId === IDS.INCREMENT_BUTTON) {
        const count = incrementCounter(interaction.guild.id, interaction.user.id);
        await interaction.reply({
            content: `✅ 你的计数已 +1，当前为 **${count}**。`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (interaction.customId === IDS.NOTE_BUTTON) {
        // 打开模态框收集文本输入
        const modal = new ModalBuilder()
            .setCustomId(IDS.NOTE_MODAL)
            .setTitle('填写备注');

        const input = new TextInputBuilder()
            .setCustomId(IDS.NOTE_INPUT)
            .setLabel('备注内容')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('随便写点什么…')
            .setRequired(true)
            .setMaxLength(200);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        await interaction.showModal(modal);
        return;
    }
}

/**
 * 处理本模块的模态框提交。
 * 由 interactionCreate 在 customId 以 `template_` 开头且 isModalSubmit() 时调用。
 */
export async function handleTemplateModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.guild) return;

    if (interaction.customId === IDS.NOTE_MODAL) {
        const note = interaction.fields.getTextInputValue(IDS.NOTE_INPUT);
        setNote(interaction.guild.id, interaction.user.id, note);

        const record = getCounter(interaction.guild.id, interaction.user.id);
        await interaction.reply({
            content: `📝 备注已保存：\n> ${note}\n\n（当前计数：**${record?.count ?? 0}**）`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
}
