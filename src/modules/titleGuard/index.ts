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

import { MODAL_APPEAL, handleAppealModal } from './components/noticePanel';
import { handleTitleGuardModal as handleAuthorFixModal } from './components/authorFixPanel';

export { handleTitleGuardButton } from './components/noticePanel';
export {
    handleTitleGuardSelect,
    handleAuthorFixButton,
} from './components/authorFixPanel';

/**
 * 模块里的模态框统一从这儿分流。
 * 核心只按 tt_ 前缀分发到模块，模块内部再按具体 customId 认领——
 * 免得每加一个弹窗就得改一次核心。
 */
export async function handleTitleGuardModal(interaction: ModalSubmitInteraction): Promise<void> {
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
