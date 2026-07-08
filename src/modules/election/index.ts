// src/modules/election/index.ts
//
// 募选模块出口（barrel）。核心只 import 这一个文件即可接入本模块。
// 交互 customId 统一前缀：`elect_`。

import type { Client } from 'discord.js';
import type { ButtonInteraction, AnySelectMenuInteraction, ModalSubmitInteraction } from 'discord.js';
import { handleConfigButton, handleConfigSelect, handleConfigModal } from './components/electionConfig';
import {
    isNominateButton,
    isNominateModal,
    handleNominateButton,
    handleNominateModal,
} from './components/electionRound';
import {
    isVoteButton,
    isBallotSelect,
    handleVoteButton,
    handleBallotSelect,
} from './components/electionVote';
import {
    isConfirmButton,
    isRejectButton,
    handleConfirmButton,
    handleRejectButton,
} from './services/electionRunner';
import { startElectionScheduler } from './services/electionScheduler';

export const ELECTION_PREFIX = 'elect_';

/** 分发本模块的按钮交互（interactionCreate 在 customId 以 `elect_` 开头时调用）。 */
export async function handleElectionButton(interaction: ButtonInteraction): Promise<void> {
    if (await handleConfigButton(interaction)) return;
    const id = interaction.customId;
    if (isNominateButton(id)) return void await handleNominateButton(interaction);
    if (isVoteButton(id)) return void await handleVoteButton(interaction);
    if (isConfirmButton(id)) return void await handleConfirmButton(interaction);
    if (isRejectButton(id)) return void await handleRejectButton(interaction);
}

/** 分发本模块的选择菜单交互。 */
export async function handleElectionSelect(interaction: AnySelectMenuInteraction): Promise<void> {
    if (await handleConfigSelect(interaction)) return;
    if (isBallotSelect(interaction.customId) && interaction.isStringSelectMenu()) {
        await handleBallotSelect(interaction);
    }
}

/** 分发本模块的 Modal 提交。 */
export async function handleElectionModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (await handleConfigModal(interaction)) return;
    if (isNominateModal(interaction.customId)) {
        await handleNominateModal(interaction);
    }
}

/**
 * 启动募选系统（clientReady 后由核心调用）。
 * 启动后台调度器，自动推进到点的场次（开投票 / 结算）。
 */
export async function startElectionSystem(client: Client): Promise<void> {
    startElectionScheduler(client);
    console.log('🗳️ 募选模块已加载');
}
