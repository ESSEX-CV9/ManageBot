import {
    ChannelType,
    PermissionFlagsBits,
    type ForumChannel,
    type Guild,
    type GuildBasedChannel,
    type MediaChannel,
    type NewsChannel,
    type TextChannel,
    type ThreadChannel,
} from 'discord.js';

import type { CleanupJob } from './types';

type ParentChannel = TextChannel | NewsChannel | ForumChannel | MediaChannel;

export interface ScopeResolution {
    channelIds: string[];
    warnings: string[];
}

const PARENT_TYPES = new Set<ChannelType>([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
]);

const ARCHIVE_FETCH_CONCURRENCY = 4;

async function forEachConcurrent<T>(
    items: T[],
    concurrency: number,
    action: (item: T) => Promise<void>,
): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (index < items.length) {
            const item = items[index++];
            await action(item);
        }
    });
    await Promise.all(workers);
}

function isParentChannel(channel: GuildBasedChannel): channel is ParentChannel {
    return PARENT_TYPES.has(channel.type);
}

function canReadAndDelete(guild: Guild, channel: TextChannel | NewsChannel | ThreadChannel): string[] {
    const me = guild.members.me;
    if (!me) return ['无法读取机器人自己的服务器成员信息'];
    const permissions = channel.permissionsFor(me);
    if (!permissions) return ['无法计算机器人权限'];

    const missing: string[] = [];
    if (!permissions.has(PermissionFlagsBits.ViewChannel)) missing.push('查看频道');
    if (!permissions.has(PermissionFlagsBits.ReadMessageHistory)) missing.push('读取消息历史');
    if (!permissions.has(PermissionFlagsBits.ManageMessages)) missing.push('管理消息');
    if (channel.isThread() && channel.archived && !permissions.has(PermissionFlagsBits.ManageThreads)) {
        missing.push('管理子区（归档区域需要临时打开）');
    }
    return missing;
}

function isExcluded(channel: GuildBasedChannel | ThreadChannel, excluded: Set<string>): boolean {
    if (excluded.has(channel.id)) return true;
    if (channel.parentId && excluded.has(channel.parentId)) return true;
    if (channel.isThread()) {
        const categoryId = channel.parent?.parentId;
        if (categoryId && excluded.has(categoryId)) return true;
    }
    return false;
}

async function fetchAllArchived(parent: ParentChannel, type: 'public' | 'private'): Promise<ThreadChannel[]> {
    const result = new Map<string, ThreadChannel>();
    let before: Date | undefined;

    for (let page = 0; page < 10_000; page++) {
        const fetched = await parent.threads.fetchArchived({
            type,
            fetchAll: type === 'private',
            before,
            limit: 100,
        }, false);

        for (const thread of fetched.threads.values()) result.set(thread.id, thread);
        if (!fetched.hasMore || fetched.threads.size === 0) break;

        const oldest = [...fetched.threads.values()]
            .map(thread => thread.archivedAt?.getTime() ?? Number.POSITIVE_INFINITY)
            .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
        if (!Number.isFinite(oldest)) break;
        before = new Date(oldest);
    }

    return [...result.values()];
}

export async function resolveCleanupScope(guild: Guild, job: CleanupJob): Promise<ScopeResolution> {
    const warnings: string[] = [];
    const selected = new Set(job.selectedChannelIds);
    const excluded = new Set(job.excludedChannelIds);
    const parents = new Map<string, ParentChannel>();
    const directThreads = new Map<string, ThreadChannel>();

    await guild.channels.fetch().catch(error => {
        warnings.push(`拉取服务器频道列表失败：${error instanceof Error ? error.message : String(error)}`);
    });

    if (job.entireGuild) {
        for (const channel of guild.channels.cache.values()) {
            if (isParentChannel(channel)) parents.set(channel.id, channel);
        }
    } else {
        for (const id of selected) {
            const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
            if (!channel) {
                warnings.push(`无法访问所选频道/子区 ${id}`);
                continue;
            }
            if (channel.type === ChannelType.GuildCategory) {
                for (const child of guild.channels.cache.values()) {
                    if (child.parentId === channel.id && isParentChannel(child)) parents.set(child.id, child);
                }
            } else if (channel.isThread()) {
                directThreads.set(channel.id, channel);
            } else if (isParentChannel(channel)) {
                parents.set(channel.id, channel);
            } else {
                warnings.push(`<#${id}> 不是可清理的文字频道、论坛、分类或子区`);
            }
        }
    }

    const allThreads = new Map<string, ThreadChannel>(directThreads);
    let activeThreads: Map<string, ThreadChannel> | null = null;
    if (parents.size > 0) {
        try {
            const fetched = await guild.channels.fetchActiveThreads(false);
            activeThreads = new Map(fetched.threads);
        } catch (error) {
            warnings.push(`读取活动子区失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const includedParents = [...parents.values()].filter(parent => !isExcluded(parent, excluded));
    const archiveParents: ParentChannel[] = [];
    for (const parent of includedParents) {
        const isForumLike = parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildMedia;
        if (!isForumLike) {
            const missing = canReadAndDelete(guild, parent);
            if (missing.length === 0) {
                // 普通文字/公告频道本体有消息；论坛和媒体频道本体没有消息。
            } else {
                warnings.push(`<#${parent.id}> 缺少权限：${missing.join('、')}`);
            }
        }

        // “全服务器”就是完整范围，不受面板之前的普通聊天子区开关影响。
        if (!isForumLike && !job.entireGuild && !job.includeThreads) continue;

        if (activeThreads) {
            for (const thread of activeThreads.values()) {
                if (thread.parentId === parent.id) allThreads.set(thread.id, thread);
            }
        }

        archiveParents.push(parent);
    }

    // 不同父频道的归档列表使用有限并发展开；Discord.js 仍负责各路由桶的限流。
    // 这可以避免全服任务在正式搜索前，因逐个探测大量空频道而等待数分钟。
    await forEachConcurrent(archiveParents, ARCHIVE_FETCH_CONCURRENCY, async parent => {
        try {
            for (const thread of await fetchAllArchived(parent, 'public')) allThreads.set(thread.id, thread);
        } catch (error) {
            warnings.push(`<#${parent.id}> 的归档公开子区/帖子读取失败：${error instanceof Error ? error.message : String(error)}`);
        }

        if (parent.type === ChannelType.GuildText) {
            try {
                for (const thread of await fetchAllArchived(parent, 'private')) allThreads.set(thread.id, thread);
            } catch (error) {
                warnings.push(`<#${parent.id}> 的归档私密子区读取失败（通常是缺少“管理子区”权限）`);
            }
        }
    });

    const resolved = new Set<string>();
    for (const parent of parents.values()) {
        if (parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildMedia) continue;
        if (isExcluded(parent, excluded)) continue;
        if (canReadAndDelete(guild, parent).length === 0) resolved.add(parent.id);
    }
    for (const thread of allThreads.values()) {
        if (isExcluded(thread, excluded)) continue;
        const missing = canReadAndDelete(guild, thread);
        if (missing.length > 0) {
            warnings.push(`<#${thread.id}> 缺少权限：${missing.join('、')}`);
            continue;
        }
        resolved.add(thread.id);
    }

    return { channelIds: [...resolved].sort(), warnings: [...new Set(warnings)] };
}
