import { GuildMember, MessageFlags } from 'discord.js';
import type { Client, Interaction, ChatInputCommandInteraction, PartialGuildMember, InteractionReplyOptions } from 'discord.js';
import type { Command } from '../../core/types';
import { getMysteryAdminRoleIds } from './permissions';
import { loadCommand, loadFunction, loadStoreFlusher } from './runtime';

type ComponentInteraction = Extract<Interaction, { customId: string }>;
type ShutdownResult = { total: number; done: number; cleanupDone: boolean };
let commands: readonly Command[] | undefined;
const activeOperations = new Set<Promise<unknown>>();
let stopping = false;
let stopTask: Promise<void> | undefined;

async function trackOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const task = operation();
    activeOperations.add(task);
    try { return await task; }
    finally { activeOperations.delete(task); }
}

async function rejectWhileStopping(interaction: ChatInputCommandInteraction | ComponentInteraction): Promise<boolean> {
    if (!stopping) return false;
    await interaction.reply({ content: '⏳ 机器人正在重启，请稍后再使用神秘指令。', flags: MessageFlags.Ephemeral });
    return true;
}

async function prepareMember(interaction: ChatInputCommandInteraction | ComponentInteraction): Promise<boolean> {
    if (!interaction.inGuild() || interaction.member instanceof GuildMember) return true;
    try {
        if (!interaction.guild) throw new Error('Guild not cached');
        interaction.member = await interaction.guild.members.fetch(interaction.user.id);
        return true;
    } catch (error) {
        console.error('[Mystery] 无法获取成员，已拒绝此次操作:', error);
        const payload = { content: '❌ 无法确认当前服务器成员信息，请稍后重试。', flags: MessageFlags.Ephemeral } satisfies InteractionReplyOptions;
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
        return false;
    }
}

export function getMysteryCommands(): readonly Command[] {
    getMysteryAdminRoleIds(); // Fail invalid permissions configuration before registering commands.
    if (!commands) {
        commands = ['mysteryCommand', 'mysterySettingsCommand', 'gameStatsCommand', 'manageCommand'].map(name => {
            const command = loadCommand(`./commands/${name}.js`);
            return {
                data: command.data,
                async execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
                    if (stopping) { await rejectWhileStopping(interaction); return; }
                    return trackOperation(async () => {
                        if (!await prepareMember(interaction)) return;
                        return command.execute(interaction);
                    });
                },
            };
        });
    }
    if (String(process.env.MYSTERY_TEST_COMMANDS).toLowerCase() !== 'true') return commands;
    const testCommand = loadCommand('./commands/pressureTestCommand.js');
    return [...commands, {
        data: testCommand.data,
        async execute(interaction: ChatInputCommandInteraction): Promise<unknown> {
            if (stopping) { await rejectWhileStopping(interaction); return; }
            return trackOperation(async () => {
                if (!await prepareMember(interaction)) return;
                return testCommand.execute(interaction);
            });
        },
    }];
}

export function registerMysteryCommands(client: Client): void {
    const additions = getMysteryCommands();
    for (const command of additions) {
        if (client.commands.has(command.data.name)) throw new Error(`神秘命令与现有命令冲突：${command.data.name}`);
    }
    for (const command of additions) client.commands.set(command.data.name, command);
}

export async function handleMysteryComponent(interaction: Interaction): Promise<boolean> {
    if (!(interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit())) return false;
    if (!interaction.customId.startsWith('mystery_')) return false;
    if (stopping) { await rejectWhileStopping(interaction); return true; }
    return trackOperation(async () => {
        if (!await prepareMember(interaction)) return true;
        if (interaction.customId.startsWith('mystery_namepool:')) {
            await loadFunction<[ComponentInteraction], Promise<boolean>>('./services/namePoolManager.js', 'handleNamePoolInteraction')(interaction);
        } else {
            await loadFunction<[ComponentInteraction], Promise<boolean>>('./services/interactionHandler.js', 'handleMysteryInteraction')(interaction);
        }
        return true;
    });
}

export async function handleMysteryMemberUpdate(oldMember: GuildMember | PartialGuildMember, newMember: GuildMember): Promise<void> {
    if (stopping) return;
    await trackOperation(() => loadFunction<[GuildMember | PartialGuildMember, GuildMember], Promise<void>>('./events/guildMemberUpdate.js', 'mysteryGuildMemberUpdateHandler')(oldMember, newMember));
}

export async function handleMysteryMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
    if (stopping) return;
    await trackOperation(() => loadFunction<[GuildMember | PartialGuildMember], Promise<void>>('./events/guildMemberRemove.js', 'mysteryGuildMemberRemoveHandler')(member));
}

export async function startMysterySystem(client: Client<true>): Promise<void> {
    if (stopping) return;
    return trackOperation(async () => {
        // Nickname locks must be restored before games can settle or replace them.
        await loadFunction<[Client<true>], Promise<void>>('./services/mysteryNicknameLock.js', 'initialize')(client);
        for (const [modulePath, exportName] of [
            ['./services/pressureRouletteGame.js', 'restorePressureGames'],
            ['./services/devilRouletteGame.js', 'restoreActiveGames'],
        ]) {
            try {
                await loadFunction<[Client<true>], Promise<void>>(modulePath, exportName)(client);
            } catch (error) {
                console.error(`[Mystery] 对局恢复失败 (${exportName})，原有模块继续运行:`, error);
            }
        }
        console.log('🎮 神秘指令模块已加载');
    });
}

export function stopMysterySystem(): Promise<void> {
    if (stopTask) return stopTask;
    stopping = true;
    stopTask = (async () => {
        // Finish accepted writes and replies before snapshotting games and stores.
        await Promise.allSettled([...activeOperations]);
        const result = await loadFunction<[{ timeoutMs: number }], Promise<ShutdownResult>>('./services/mysteryGameManager.js', 'shutdownAllGames')({ timeoutMs: 8000 });
        const cleanupResults = await Promise.allSettled([
            loadFunction<[], Promise<void>>('./services/duelPunishment.js', 'shutdown')(),
            loadFunction<[], Promise<void>>('./services/mysteryNicknameLock.js', 'shutdown')(),
        ]);
        const flushers = [
            () => loadFunction<[{ strict: boolean }], Promise<void>>('./utils/bombCooldownStore.js', 'flush')({ strict: true }),
            () => loadFunction<[{ strict: boolean }], Promise<void>>('./utils/devilRouletteResumeStore.js', 'flush')({ strict: true }),
            () => loadFunction<[{ strict: boolean }], Promise<void>>('./utils/pressureGameStore.js', 'flush')({ strict: true }),
            loadStoreFlusher('./utils/channelAccessStore.js', 'defaultChannelAccessStore'),
            loadStoreFlusher('./services/mysteryNicknameLock.js', 'store'),
        ];
        const writes = await Promise.allSettled(flushers.map(flush => flush()));
        if (result.total) console.log(`[Mystery] 已收尾 ${result.done}/${result.total} 场对局`);
        const failure = [...cleanupResults, ...writes].find((write): write is PromiseRejectedResult => write.status === 'rejected');
        if (failure) throw failure.reason;
        if (result.done !== result.total || !result.cleanupDone) throw new Error('部分神秘对局或按钮未能完成退出收尾。');
    })();
    return stopTask;
}
