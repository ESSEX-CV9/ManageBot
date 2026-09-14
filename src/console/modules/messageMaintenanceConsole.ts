import {
    cancelGuildMessageIndex,
    cancelJob,
    createJob,
    findActiveJob,
    getGuildIndexScanProgress,
    getGuildMessageIndex,
    getJobScanProgress,
    listChannelSnapshots,
    listGuildSnapshots,
    listJobs,
    pauseGuildMessageIndex,
    pauseJob,
    requestGuildMessageIndex,
    resumeGuildMessageIndex,
    resumeJob,
    updateGuildIndexPriorities,
    type ChannelSnapshot,
} from '../../modules/messageCleanup/services/messageCleanupDatabase';
import {
    formatShanghaiTime,
    parseCleanupCutoff,
} from '../../modules/messageCleanup/services/cleanupTime';
import type { CleanupJob, GuildMessageIndex } from '../../modules/messageCleanup/services/types';
import type { ConsoleContext, ConsoleModule } from '../types';

const LOCAL_ACTOR = 'server-console';
const SNOWFLAKE = /^\d{17,20}$/;

const JOB_STATUS: Record<CleanupJob['status'], string> = {
    queued: '等待开始',
    running: '运行中',
    paused: '已暂停',
    cancelled: '已取消',
    completed: '已完成',
    failed: '失败',
};

const INDEX_STATUS: Record<GuildMessageIndex['status'], string> = {
    queued: '等待后台补齐',
    running: '正在建立',
    paused: '已暂停',
    cancelled: '已取消',
    completed: '可用',
    failed: '部分失败',
};

function idsFromText(raw: string): string[] {
    const result = new Set<string>();
    const linkPattern = /(?:https?:\/\/)?(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:@me|\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?/gi;
    let remaining = raw;
    for (const match of raw.matchAll(linkPattern)) {
        result.add(match[1]);
        remaining = remaining.replace(match[0], ' ');
    }
    for (const id of remaining.match(/\d{17,20}/g) ?? []) result.add(id);
    return [...result];
}

function firstId(raw: string): string | null {
    return raw.match(/\d{17,20}/)?.[0] ?? null;
}

async function askPriorityIds(
    context: ConsoleContext,
    current: string[],
    emptyKeepsCurrent: boolean,
): Promise<string[]> {
    console.log('\n一次可以输入最多 25 个频道、分类或论坛。');
    console.log('可以逐个输入，也可以使用空格、逗号分隔后一次粘贴多个 ID/链接。');
    if (current.length > 0) console.log(`当前已选择 ${current.length} 个：${current.join(', ')}`);
    let raw = await context.rl.question(
        emptyKeepsCurrent ? '新的优先范围（留空保持当前）：' : '新的优先范围（留空即清空）：',
    );
    if (!raw.trim()) return emptyKeepsCurrent ? current : [];

    const selected = new Set<string>();
    while (true) {
        const before = selected.size;
        for (const id of idsFromText(raw)) {
            selected.add(id);
            if (selected.size >= 25) break;
        }
        if (selected.size === before) console.log('没有识别到有效的频道 ID 或链接，请重新输入。');
        if (selected.size >= 25) {
            console.log('已达到 25 个优先范围上限。');
            break;
        }
        raw = await context.rl.question(`已选择 ${selected.size} 个；继续输入，或留空完成：`);
        if (!raw.trim()) break;
    }
    return [...selected];
}

function terminalText(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function channelMap(guildId: string): Map<string, ChannelSnapshot> {
    return new Map(listChannelSnapshots(guildId).map(channel => [channel.channelId, channel]));
}

function channelPath(channelId: string, channels: Map<string, ChannelSnapshot>): string {
    const channel = channels.get(channelId);
    if (!channel) return `未知频道 [${channelId}]`;
    const parent = channel.parentName ?? (channel.parentId ? channels.get(channel.parentId)?.name : null);
    return terminalText(`${parent ? `${parent} › ` : ''}${channel.name} [${channel.channelId}]`);
}

function expandedPriorities(
    scopeChannelIds: string[],
    selectedIds: string[],
    channels: Map<string, ChannelSnapshot>,
): string[] {
    const selected = new Set(selectedIds);
    return scopeChannelIds.filter(channelId => {
        if (selected.has(channelId)) return true;
        const channel = channels.get(channelId);
        if (!channel?.parentId) return false;
        if (selected.has(channel.parentId)) return true;
        const parent = channels.get(channel.parentId);
        return Boolean(parent?.parentId && selected.has(parent.parentId));
    });
}

function printTask(job: CleanupJob | null, guildId: string, channels: Map<string, ChannelSnapshot>): void {
    console.log('\n当前消息任务');
    console.log('─'.repeat(44));
    if (!job) {
        const latest = listJobs(guildId, 1)[0];
        console.log(latest
            ? `没有运行中的任务；最近任务状态：${JOB_STATUS[latest.status]}`
            : '尚无任务');
        return;
    }

    const progress = getJobScanProgress(job.id);
    console.log(`#${job.id}  ${JOB_STATUS[job.status]}  目标 ${job.targetUserId}${job.indexOnly ? '  ⚡ 仅现有索引' : ''}`);
    console.log(`发现 ${job.foundCount}  待删除 ${job.pendingCount}  已删除 ${job.deletedCount}  跳过 ${job.skippedCount}  失败 ${job.failedCount}`);
    console.log(`范围 ${job.scopeCount || '待展开'} 个频道/子区  历史读取 ${progress.scannedMessageCount} 条 / ${progress.scannedPageCount} 页`);
    if (job.scanCompletedAt) console.log('扫描器：已经完成');
    else if (job.scanMode === 'search' && progress.activeChannels.length === 0) console.log('扫描器：Discord 作者快速搜索/展开范围');
    for (const channel of progress.activeChannels) {
        console.log(`  扫描中：${channelPath(channel.channelId, channels)}`);
        console.log(`          ${channel.scannedMessageCount} 条 / ${channel.scannedPageCount} 页`);
    }
    if (job.warningText) console.log(`提示：${terminalText(job.warningText).slice(0, 300)}`);
    if (job.error) console.log(`错误：${terminalText(job.error).slice(0, 300)}`);
}

function printIndex(index: GuildMessageIndex | null, guildId: string, channels: Map<string, ChannelSnapshot>): void {
    console.log('\n服务器消息索引');
    console.log('─'.repeat(44));
    if (!index) {
        console.log('尚未建立；首次启动消息任务时也会自动建立。');
        return;
    }
    const progress = getGuildIndexScanProgress(guildId);
    console.log(`${INDEX_STATUS[index.status]}  完成 ${index.completedCount}/${index.scopeCount || '待展开'} 个频道/子区`);
    console.log(`索引现存 ${index.indexedMessageCount} 条  本轮读取 ${progress.scannedMessageCount} 条 / ${progress.scannedPageCount} 页`);
    for (const channel of progress.activeChannels) {
        console.log(`  建库中：${channelPath(channel.channelId, channels)}`);
        console.log(`          ${channel.scannedMessageCount} 条 / ${channel.scannedPageCount} 页`);
    }
    if (index.warningText) console.log(`提示：${terminalText(index.warningText).slice(0, 300)}`);
    if (index.error) console.log(`错误：${terminalText(index.error).slice(0, 300)}`);
}

function renderDashboard(guildId: string, guildName: string): void {
    process.stdout.write('\x1b[2J\x1b[H');
    const channels = channelMap(guildId);
    console.log(`Manage Bot · 内容维护 · ${terminalText(guildName)}`);
    console.log(`服务器：${guildId}`);
    console.log('═'.repeat(60));
    printTask(findActiveJob(guildId), guildId, channels);
    printIndex(getGuildMessageIndex(guildId), guildId, channels);
}

async function watchDashboard(context: ConsoleContext, guildId: string, guildName: string): Promise<void> {
    renderDashboard(guildId, guildName);
    console.log('\n每秒自动刷新；按 Enter 返回菜单。');
    const timer = setInterval(() => {
        renderDashboard(guildId, guildName);
        console.log('\n每秒自动刷新；按 Enter 返回菜单。');
    }, 1_000);
    try {
        await context.rl.question('');
    } finally {
        clearInterval(timer);
    }
}

async function chooseGuild(context: ConsoleContext): Promise<{ guildId: string; name: string } | null> {
    const snapshots = listGuildSnapshots();
    const known = new Map(snapshots.map(guild => [guild.guildId, guild.name]));
    for (const id of (process.env.GUILD_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
        if (SNOWFLAKE.test(id) && !known.has(id)) known.set(id, `服务器 ${id}`);
    }
    const guilds = [...known].map(([guildId, name]) => ({ guildId, name }));

    context.clear();
    console.log('选择服务器');
    console.log('═'.repeat(44));
    guilds.forEach((guild, index) => console.log(`${index + 1}. ${guild.name} [${guild.guildId}]`));
    console.log('也可以直接输入服务器 ID；输入 0 返回。');
    const answer = (await context.rl.question('\n服务器：')).trim();
    if (answer === '0') return null;
    const selected = guilds[Number(answer) - 1];
    if (selected) return selected;
    if (SNOWFLAKE.test(answer)) return { guildId: answer, name: known.get(answer) ?? `服务器 ${answer}` };
    await context.pause('输入无效，按 Enter 继续...');
    return chooseGuild(context);
}

async function chooseCutoff(context: ConsoleContext): Promise<{ timestamp: number; label: string } | null> {
    console.log('\n截止时间：1=全部历史  2=一天前  3=七天前  4=三十天前  5=自定义北京时间');
    const mode = (await context.rl.question('选择：')).trim();
    const now = Date.now();
    const days = mode === '2' ? 1 : mode === '3' ? 7 : mode === '4' ? 30 : 0;
    if (days > 0) {
        const timestamp = now - days * 24 * 60 * 60_000;
        return { timestamp, label: `${days} 天前（北京时间 ${formatShanghaiTime(timestamp)}）` };
    }
    if (mode === '5') {
        const raw = await context.rl.question('北京时间（YYYY-MM-DD HH:mm）：');
        const timestamp = parseCleanupCutoff(raw);
        return timestamp ? { timestamp, label: `北京时间 ${formatShanghaiTime(timestamp)}` } : null;
    }
    if (mode !== '1') return null;
    return { timestamp: now, label: '全部历史（任务启动前）' };
}

async function createTask(context: ConsoleContext, guildId: string): Promise<void> {
    context.clear();
    console.log('新建消息维护任务');
    console.log('═'.repeat(44));
    const targetUserId = firstId(await context.rl.question('目标用户 ID：'));
    if (!targetUserId) {
        await context.pause('用户 ID 无效，按 Enter 返回...');
        return;
    }

    const entire = (await context.rl.question('范围使用全服务器？[Y/n]：')).trim().toLowerCase() !== 'n';
    let selectedChannelIds: string[] = [];
    let includeThreads = true;
    if (!entire) {
        selectedChannelIds = idsFromText(await context.rl.question('频道/分类/论坛 ID 或链接（空格分隔）：'));
        if (selectedChannelIds.length === 0) {
            await context.pause('至少需要一个范围 ID，按 Enter 返回...');
            return;
        }
        includeThreads = (await context.rl.question('普通聊天频道包含子区？[Y/n]：')).trim().toLowerCase() !== 'n';
    }
    const excludedChannelIds = idsFromText(await context.rl.question('排除频道/子区/分类 ID 或链接（可留空）：'));
    const indexOnly = (await context.rl.question('只删除现有索引中的消息，不扫描 Discord？[y/N]：')).trim().toLowerCase() === 'y';
    const cutoff = await chooseCutoff(context);
    if (!cutoff) {
        await context.pause('截止时间无效，按 Enter 返回...');
        return;
    }

    console.log(`\n目标：${targetUserId}`);
    console.log(`范围：${entire ? '全服务器' : selectedChannelIds.join(', ')}`);
    console.log(`截止：${cutoff.label}`);
    console.log(`排除：${excludedChannelIds.length ? excludedChannelIds.join(', ') : '无'}`);
    console.log(`发现方式：${indexOnly ? '仅使用现有索引' : '索引优先，并完整核验 Discord 历史'}`);
    const confirmed = (await context.rl.question('立即创建？[y/N]：')).trim().toLowerCase() === 'y';
    if (!confirmed) return;

    const result = createJob({
        guildId,
        actorId: LOCAL_ACTOR,
        targetUserId,
        selectedChannelIds,
        entireGuild: entire,
        excludedChannelIds,
        includeThreads,
        indexOnly,
        cutoffAt: cutoff.timestamp,
        cutoffLabel: cutoff.label,
    });
    const message = result.created && result.job
        ? `任务 #${result.job.id} 已进入队列。`
        : result.clearing
            ? 'Discord 任务列表正在收尾，请稍后再试。'
            : result.job
                ? `已有未结束任务 #${result.job.id}，没有重复创建。`
                : '任务创建失败。';
    await context.pause(`${message}\n按 Enter 继续...`);
}

async function searchChannels(context: ConsoleContext, guildId: string): Promise<void> {
    const query = (await context.rl.question('频道名称或 ID 关键字：')).trim().toLowerCase();
    if (!query) return;
    const channels = listChannelSnapshots(guildId);
    const map = new Map(channels.map(channel => [channel.channelId, channel]));
    const matches = channels
        .filter(channel => channel.channelId.includes(query)
            || channel.name.toLowerCase().includes(query)
            || channel.parentName?.toLowerCase().includes(query))
        .slice(0, 40);
    console.log('');
    for (const channel of matches) console.log(channelPath(channel.channelId, map));
    if (matches.length === 0) console.log('没有匹配的本地频道快照；可直接从 Discord 复制频道 ID。');
    await context.pause();
}

async function indexMenu(context: ConsoleContext, guildId: string): Promise<void> {
    while (true) {
        context.clear();
        const index = getGuildMessageIndex(guildId);
        console.log('服务器消息索引');
        console.log('═'.repeat(44));
        console.log(index
            ? `${INDEX_STATUS[index.status]}  ${index.completedCount}/${index.scopeCount || '待展开'} 个频道/子区  ${index.indexedMessageCount} 条消息`
            : '尚未建立');
        console.log(`优先范围：${index?.priorityChannelIds.length ? index.priorityChannelIds.join(', ') : '未设置'}`);
        console.log('\n1. 开始/刷新补齐');
        console.log('2. 修改当前优先范围');
        console.log(index?.status === 'paused' ? '3. 继续' : '3. 暂停');
        console.log('4. 取消');
        console.log('0. 返回');
        const action = (await context.rl.question('\n操作：')).trim();
        if (action === '0') return;
        if (action === '1') {
            const priorities = await askPriorityIds(context, index?.priorityChannelIds ?? [], true);
            const result = requestGuildMessageIndex(guildId, LOCAL_ACTOR, priorities);
            if (!result.created) {
                const channels = channelMap(guildId);
                updateGuildIndexPriorities(
                    guildId,
                    priorities,
                    expandedPriorities(result.index.scopeChannelIds, priorities, channels),
                );
            }
            await context.pause(result.created
                ? `索引已进入队列，优先范围 ${priorities.length} 个。按 Enter 继续...`
                : `当前索引的优先范围已更新为 ${priorities.length} 个。按 Enter 继续...`);
        } else if (action === '2') {
            if (!index) {
                await context.pause('尚未建立索引，按 Enter 继续...');
                continue;
            }
            const priorities = await askPriorityIds(context, index.priorityChannelIds, false);
            const channels = channelMap(guildId);
            updateGuildIndexPriorities(
                guildId,
                priorities,
                expandedPriorities(index.scopeChannelIds, priorities, channels),
            );
        } else if (action === '3') {
            if (index?.status === 'paused') resumeGuildMessageIndex(guildId);
            else pauseGuildMessageIndex(guildId);
        } else if (action === '4') {
            cancelGuildMessageIndex(guildId);
        }
    }
}

async function run(context: ConsoleContext): Promise<void> {
    let selected = await chooseGuild(context);
    if (!selected) return;

    while (true) {
        renderDashboard(selected.guildId, selected.name);
        console.log('\n操作');
        console.log('─'.repeat(44));
        console.log('1. 新建消息任务');
        console.log('2. 暂停/继续当前任务');
        console.log('3. 取消当前任务');
        console.log('4. 索引设置');
        console.log('5. 实时监控');
        console.log('6. 查找频道 ID');
        console.log('7. 切换服务器');
        console.log('0. 返回主菜单');
        const action = (await context.rl.question('\n操作：')).trim();
        if (action === '0') return;
        if (action === '1') {
            await createTask(context, selected.guildId);
        } else if (action === '2') {
            const active = findActiveJob(selected.guildId);
            if (!active) await context.pause('当前没有可控制的任务，按 Enter 继续...');
            else if (active.status === 'paused') resumeJob(active.id, LOCAL_ACTOR);
            else pauseJob(active.id, LOCAL_ACTOR);
        } else if (action === '3') {
            const active = findActiveJob(selected.guildId);
            if (!active) await context.pause('当前没有可取消的任务，按 Enter 继续...');
            else {
                const confirmed = (await context.rl.question(`取消任务 #${active.id}？[y/N]：`)).trim().toLowerCase() === 'y';
                if (confirmed) cancelJob(active.id, LOCAL_ACTOR);
            }
        } else if (action === '4') {
            await indexMenu(context, selected.guildId);
        } else if (action === '5') {
            await watchDashboard(context, selected.guildId, selected.name);
        } else if (action === '6') {
            await searchChannels(context, selected.guildId);
        } else if (action === '7') {
            const next = await chooseGuild(context);
            if (next) selected = next;
        }
    }
}

const messageMaintenanceConsole: ConsoleModule = {
    id: 'message-maintenance',
    title: '内容维护',
    description: '创建消息任务、管理索引并查看实时扫描进度',
    run,
};

export default messageMaintenanceConsole;
