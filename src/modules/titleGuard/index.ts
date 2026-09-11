// src/modules/titleGuard/index.ts
//
// 标题与 TAG 规范模块的统一出口。
// 核心只 import 这一个文件（命令除外，命令由 core/index.ts 单独注册）。
//
// 设计文档：docs/标题与TAG规范模块设计.md

import { Events, type Client, type ThreadChannel } from 'discord.js';

import { startTitleGuardScheduler } from './services/titleGuardScheduler';
import { titleGuardThreadCreate, titleGuardThreadUpdate } from './events/threadEvents';

import type { ModalSubmitInteraction } from 'discord.js';

import type { AnySelectMenuInteraction, ButtonInteraction } from 'discord.js';

import { MODAL_APPEAL, handleAppealModal, handleTitleGuardButton as handleNoticeButton } from './components/noticePanel';
import {
    handleAuthorFixButton,
    handleTitleGuardModal as handleAuthorFixModal,
    handleTitleGuardSelect as handleAuthorFixSelect,
} from './components/authorFixPanel';
import {
    handleConfigButton,
    handleConfigModal,
    handleConfigSelect,
} from './components/configPanel';

/**
 * 模块里所有 tt_ 按钮从这儿分流。
 *
 * 顺序要紧：配置台的 customId 里没有案件编号，
 * 让通知面板先接的话它会把 `tt_cfg:home` 解析成「案件 NaN」，回一句「记录不存在」。
 */
export async function handleTitleGuardButton(interaction: ButtonInteraction): Promise<void> {
    if (await handleConfigButton(interaction)) return;
    if (await handleAuthorFixButton(interaction)) return;
    await handleNoticeButton(interaction);
}

export async function handleTitleGuardSelect(interaction: AnySelectMenuInteraction): Promise<void> {
    if (await handleConfigSelect(interaction)) return;
    await handleAuthorFixSelect(interaction);
}

/**
 * 模块里的模态框统一从这儿分流。
 * 核心只按 tt_ 前缀分发到模块，模块内部再按具体 customId 认领——
 * 免得每加一个弹窗就得改一次核心。
 */
export async function handleTitleGuardModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (await handleConfigModal(interaction)) return;
    if (interaction.customId.startsWith(MODAL_APPEAL)) {
        await handleAppealModal(interaction);
        return;
    }
    await handleAuthorFixModal(interaction);
}

/**
 * 启动标题规范系统（在 clientReady 后由核心调用）。
 * 帖子事件在这里自行绑定，不用改核心的事件聚合器。
 */
export async function startTitleGuardSystem(client: Client): Promise<void> {
    client.on(Events.ThreadCreate, (thread) => {
        void titleGuardThreadCreate(thread as ThreadChannel);
    });

    client.on(Events.ThreadUpdate, (oldThread, newThread) => {
        void titleGuardThreadUpdate(oldThread as ThreadChannel, newThread as ThreadChannel);
    });

    startTitleGuardScheduler(client);
    console.log('🏷️ 标题规范模块已加载');
}
