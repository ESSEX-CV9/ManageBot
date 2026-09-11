import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} from 'discord.js';
import type { RoleRotationConfig, RotationRound } from '../services/roleRotationDatabase';

export const ROTATION_IDS = {
    KEEP: 'rr_keep_',
    LEAVE: 'rr_leave_',
    APPLY: 'rr_apply_',
    CONFIRM: 'rr_confirm_',
    CANCEL: 'rr_cancel_',
} as const;

const sec = (value: number) => Math.floor(value / 1000);

export function buildInquiryMessage(
    config: RoleRotationConfig,
    round: RotationRound,
    participantCount: number,
    result?: { kept: number; removed: number; removalFailed: number },
) {
    const closed = Boolean(result);
    const description = closed
        ? [
            `本轮 <@&${config.managedRoleId}> 留任问询已经结束。`,
            `保留：**${result!.kept}** 人｜卸任：**${result!.removed}** 人｜处理失败：**${result!.removalFailed}** 人`,
        ].join('\n')
        : [
            `<@&${config.managedRoleId}> 的非 Bot 成员请在截止前确认是否继续担任。`,
            `截止时间：<t:${sec(round.inquiryDeadline)}:f>（<t:${sec(round.inquiryDeadline)}:R>）`,
            '',
            '未在截止前作答将被自动卸任；选择一经提交不可修改。',
            '多个通知频道共享同一份回答记录，只需在任意一个频道作答一次。',
        ].join('\n');

    const embed = new EmbedBuilder()
        .setTitle(closed ? '📋 月度留任问询已结束' : '📋 月度留任确认')
        .setColor(closed ? 0x99aab5 : 0x5865f2)
        .setDescription(description)
        .addFields({ name: '本轮问询人数', value: String(participantCount), inline: true })
        .setFooter({ text: `轮替场次 #${round.id}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${ROTATION_IDS.KEEP}${round.id}`)
            .setLabel('继续担任')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
            .setDisabled(closed),
        new ButtonBuilder()
            .setCustomId(`${ROTATION_IDS.LEAVE}${round.id}`)
            .setLabel('不再担任')
            .setEmoji('👋')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(closed),
    );

    return {
        content: closed ? '' : `<@&${config.managedRoleId}>`,
        embeds: [embed],
        components: [row],
        allowedMentions: {
            parse: [] as const,
            roles: closed ? [] : [config.managedRoleId],
            users: [],
        },
    };
}

export function buildRecruitmentMessage(
    config: RoleRotationConfig,
    round: RotationRound,
    currentMembers: number,
    options: {
        closedReason?: string;
        conflictRoleNames?: string[];
    } = {},
) {
    const { closedReason, conflictRoleNames } = options;
    const vacancies = Math.max(0, config.capacity - currentMembers);
    const closed = Boolean(closedReason) || vacancies === 0;
    const conflictLabels = conflictRoleNames ?? config.conflictRoleIds.map(id => `身份组 ${id}`);
    const conflictText = conflictLabels.length
        ? conflictLabels.map(name => `\`${name.replace(/`/g, 'ˋ')}\``).join('、')
        : '无';
    const embed = new EmbedBuilder()
        .setTitle(closed ? '📣 分管身份组招募已结束' : '📣 分管身份组公开招募')
        .setColor(closed ? 0x99aab5 : 0x57f287)
        .setDescription([
            `招募身份组：<@&${config.managedRoleId}>`,
            `当前人数：**${currentMembers}/${config.capacity}**｜剩余名额：**${vacancies}**`,
            `最低入服时长：**${config.minTenureDays} 天**${config.minTenureDays === 0 ? '（不限制）' : ''}`,
            `冲突身份组：${conflictText}`,
            '',
            closed
                ? `本轮招募已结束${closedReason ? `：${closedReason}` : '：名额已满'}。`
                : '点击申请后会出现仅你可见的二次确认。最终确认通过的先后顺序决定名额。',
        ].join('\n'))
        .setFooter({ text: `轮替场次 #${round.id}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${ROTATION_IDS.APPLY}${round.id}`)
            .setLabel(closed ? '招募已结束' : '申请担任')
            .setEmoji('🙋')
            .setStyle(closed ? ButtonStyle.Secondary : ButtonStyle.Primary)
            .setDisabled(closed),
    );
    return {
        content: '',
        embeds: [embed],
        components: [row],
        allowedMentions: { parse: [] as const },
    };
}

export function buildApplicationConfirmation(config: RoleRotationConfig, round: RotationRound) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${ROTATION_IDS.CONFIRM}${round.id}`)
            .setLabel('确认申请')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${ROTATION_IDS.CANCEL}${round.id}`)
            .setLabel('取消')
            .setStyle(ButtonStyle.Secondary),
    );
    return {
        content: `请确认申请 <@&${config.managedRoleId}>。确认时会再次检查入服时间、冲突身份组和实时剩余名额。`,
        components: [row],
        allowedMentions: { parse: [] as const },
    };
}
