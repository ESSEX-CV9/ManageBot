import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import {
    cancelGuildMessageIndex,
    cancelJob,
    createJob,
    findActiveJob,
    getGuildIndexPriorityProgress,
    getGuildIndexScanProgress,
    getGuildMessageIndex,
    getJob,
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

const HOST = '127.0.0.1';
const LOCAL_ACTOR = 'server-web-console';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SELECTED_CHANNELS = 25;
const SNOWFLAKE = /^\d{17,20}$/;
const SELECTABLE_CHANNEL_TYPES = new Set([0, 4, 5, 10, 11, 12, 15, 16]);

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

export interface LocalControlServerHandle {
    port: number;
    url: string;
    close: () => Promise<void>;
}

function panelHtml(): string {
    const candidates = [
        path.join(process.cwd(), 'src', 'console', 'web', 'control-panel.html'),
        path.join(__dirname, 'control-panel.html'),
    ];
    for (const candidate of candidates) {
        try {
            return readFileSync(candidate, 'utf8');
        } catch {
            // 尝试下一个位置，兼容 tsx 源码运行和编译目录运行。
        }
    }
    throw new Error('找不到本地网页控制台文件 control-panel.html');
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(html);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, '请求必须使用 application/json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求内容过大');
        chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('JSON body must be an object');
        }
        return parsed as Record<string, unknown>;
    } catch {
        throw new HttpError(400, 'JSON 格式无效');
    }
}

function safeTokenEqual(expected: string, received: string): boolean {
    const left = Buffer.from(expected);
    const right = Buffer.from(received);
    return left.length === right.length && timingSafeEqual(left, right);
}

function requireGuildId(value: unknown): string {
    const guildId = String(value ?? '').trim();
    if (!SNOWFLAKE.test(guildId)) throw new HttpError(400, '服务器 ID 无效');
    return guildId;
}

function parseIds(value: unknown, max = MAX_SELECTED_CHANNELS): string[] {
    if (value === undefined || value === null || value === '') return [];
    const rawValues = Array.isArray(value) ? value : [value];
    const result = new Set<string>();
    for (const raw of rawValues) {
        const text = String(raw ?? '').trim();
        if (!SNOWFLAKE.test(text)) throw new HttpError(400, `ID 无效：${text.slice(0, 80)}`);
        result.add(text);
        if (result.size > max) throw new HttpError(400, `最多只能选择 ${max} 个范围`);
    }
    return [...result];
}

function firstSnowflake(value: unknown): string {
    const id = String(value ?? '').match(/\d{17,20}/)?.[0] ?? '';
    if (!SNOWFLAKE.test(id)) throw new HttpError(400, '目标用户 ID 无效');
    return id;
}

function channelMap(guildId: string): Map<string, ChannelSnapshot> {
    return new Map(listChannelSnapshots(guildId).map(channel => [channel.channelId, channel]));
}

function channelLabel(channelId: string, channels: Map<string, ChannelSnapshot>): string {
    const channel = channels.get(channelId);
    if (!channel) return `未知频道 [${channelId}]`;
    const parentName = channel.parentName
        ?? (channel.parentId ? channels.get(channel.parentId)?.name : null);
    return `${parentName ? `${parentName} / ` : ''}${channel.name}`;
}

function channelRef(channelId: string, channels: Map<string, ChannelSnapshot>): Record<string, unknown> {
    const channel = channels.get(channelId);
    return {
        id: channelId,
        label: channelLabel(channelId, channels),
        type: channel?.channelType ?? null,
        parentId: channel?.parentId ?? null,
    };
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

function progressView(
    progress: ReturnType<typeof getJobScanProgress>,
    channels: Map<string, ChannelSnapshot>,
): Record<string, unknown> {
    return {
        scannedPageCount: progress.scannedPageCount,
        scannedMessageCount: progress.scannedMessageCount,
        activeChannels: progress.activeChannels.map(channel => ({
            ...channel,
            channel: channelRef(channel.channelId, channels),
        })),
    };
}

function stateView(guildId: string): Record<string, unknown> {
    const guild = listGuildSnapshots().find(item => item.guildId === guildId)
        ?? { guildId, name: `服务器 ${guildId}`, updatedAt: 0 };
    const channels = channelMap(guildId);
    const activeJob = findActiveJob(guildId);
    const latestJob = activeJob ?? listJobs(guildId, 1)[0] ?? null;
    const index = getGuildMessageIndex(guildId);

    const job = latestJob ? {
        id: latestJob.id,
        targetUserId: latestJob.targetUserId,
        status: latestJob.status,
        entireGuild: latestJob.entireGuild,
        includeThreads: latestJob.includeThreads,
        indexOnly: latestJob.indexOnly,
        cutoffAt: latestJob.cutoffAt,
        cutoffLabel: latestJob.cutoffLabel,
        scopeCount: latestJob.scopeCount,
        scanMode: latestJob.scanMode,
        scanCompletedAt: latestJob.scanCompletedAt,
        foundCount: latestJob.foundCount,
        pendingCount: latestJob.pendingCount,
        deletedCount: latestJob.deletedCount,
        skippedCount: latestJob.skippedCount,
        failedCount: latestJob.failedCount,
        warningText: latestJob.warningText,
        error: latestJob.error,
        createdAt: latestJob.createdAt,
        updatedAt: latestJob.updatedAt,
        selectedChannels: latestJob.selectedChannelIds.map(id => channelRef(id, channels)),
        excludedChannels: latestJob.excludedChannelIds.map(id => channelRef(id, channels)),
        progress: progressView(getJobScanProgress(latestJob.id), channels),
    } : null;

    const indexView = index ? {
        status: index.status,
        scopeCount: index.scopeCount,
        completedCount: index.completedCount,
        indexedMessageCount: index.indexedMessageCount,
        cutoffAt: index.cutoffAt,
        warningText: index.warningText,
        error: index.error,
        updatedAt: index.updatedAt,
        priorities: index.priorityChannelIds.map(id => channelRef(id, channels)),
        priorityProgress: getGuildIndexPriorityProgress(guildId),
        progress: progressView(getGuildIndexScanProgress(guildId), channels),
    } : null;

    return {
        now: Date.now(),
        guild,
        activeJobId: activeJob?.id ?? null,
        job,
        index: indexView,
    };
}

function cutoffFromBody(body: Record<string, unknown>): { timestamp: number; label: string } {
    const mode = String(body.cutoffMode ?? 'all');
    const now = Date.now();
    const days = mode === '1d' ? 1 : mode === '7d' ? 7 : mode === '30d' ? 30 : 0;
    if (days > 0) {
        const timestamp = now - days * 24 * 60 * 60_000;
        return { timestamp, label: `${days} 天前（北京时间 ${formatShanghaiTime(timestamp)}）` };
    }
    if (mode === 'custom') {
        const timestamp = parseCleanupCutoff(String(body.customCutoff ?? ''));
        if (!timestamp) throw new HttpError(400, '自定义截止时间无效，请使用 YYYY-MM-DD HH:mm');
        return { timestamp, label: `北京时间 ${formatShanghaiTime(timestamp)}` };
    }
    if (mode !== 'all') throw new HttpError(400, '截止时间选项无效');
    return { timestamp: now, label: '全部历史（任务启动前）' };
}

function changedResult(changed: boolean, success: string): Record<string, unknown> {
    if (!changed) throw new HttpError(409, '状态已经变化，请刷新页面后重试');
    return { ok: true, message: success };
}

export async function startLocalControlServer(requestedPort = 3210): Promise<LocalControlServerHandle> {
    const html = panelHtml();
    const token = randomBytes(24).toString('base64url');

    const server = createServer(async (req, res) => {
        try {
            const listeningAddress = server.address();
            const port = listeningAddress && typeof listeningAddress !== 'string'
                ? listeningAddress.port
                : requestedPort;
            const baseUrl = `http://${HOST}:${port}`;
            const url = new URL(req.url ?? '/', baseUrl);

            if (url.pathname === '/' && req.method === 'GET') {
                sendHtml(res, html);
                return;
            }

            if (!url.pathname.startsWith('/api/')) {
                throw new HttpError(404, 'Not Found');
            }

            const origin = req.headers.origin;
            if (origin && origin !== baseUrl) throw new HttpError(403, '拒绝外部网页调用本地接口');
            const authorization = String(req.headers.authorization ?? '');
            const receivedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
            if (!receivedToken || !safeTokenEqual(token, receivedToken)) {
                throw new HttpError(401, '本地访问密钥无效，请从 console 输出的完整地址重新打开');
            }

            if (url.pathname === '/api/guilds' && req.method === 'GET') {
                const known = new Map(listGuildSnapshots().map(guild => [guild.guildId, guild]));
                for (const guildId of (process.env.GUILD_IDS ?? '').split(',').map(value => value.trim())) {
                    if (SNOWFLAKE.test(guildId) && !known.has(guildId)) {
                        known.set(guildId, { guildId, name: `服务器 ${guildId}`, updatedAt: 0 });
                    }
                }
                sendJson(res, { guilds: [...known.values()] });
                return;
            }

            if (url.pathname === '/api/state' && req.method === 'GET') {
                sendJson(res, stateView(requireGuildId(url.searchParams.get('guildId'))));
                return;
            }

            if (url.pathname === '/api/channels' && req.method === 'GET') {
                const guildId = requireGuildId(url.searchParams.get('guildId'));
                const query = String(url.searchParams.get('q') ?? '').trim().toLocaleLowerCase('zh-CN');
                const all = listChannelSnapshots(guildId)
                    .filter(channel => SELECTABLE_CHANNEL_TYPES.has(channel.channelType));
                const channels = new Map(all.map(channel => [channel.channelId, channel]));
                const matched = all.filter(channel => {
                    if (!query) return true;
                    return channel.channelId.includes(query)
                        || channel.name.toLocaleLowerCase('zh-CN').includes(query)
                        || channel.parentName?.toLocaleLowerCase('zh-CN').includes(query);
                });
                sendJson(res, {
                    channels: matched.slice(0, 100).map(channel => channelRef(channel.channelId, channels)),
                    total: matched.length,
                });
                return;
            }

            const jobAction = /^\/api\/jobs\/(\d+)\/(pause|resume|cancel)$/.exec(url.pathname);
            if (jobAction && req.method === 'POST') {
                const body = await readJson(req);
                const jobId = Number(jobAction[1]);
                const job = getJob(jobId);
                if (!job || job.guildId !== requireGuildId(body.guildId)) throw new HttpError(404, '任务不存在');
                const changed = jobAction[2] === 'pause'
                    ? pauseJob(jobId, LOCAL_ACTOR)
                    : jobAction[2] === 'resume'
                        ? resumeJob(jobId, LOCAL_ACTOR)
                        : cancelJob(jobId, LOCAL_ACTOR);
                const label = jobAction[2] === 'pause' ? '任务已暂停' : jobAction[2] === 'resume' ? '任务已继续' : '任务已取消';
                sendJson(res, changedResult(changed, label));
                return;
            }

            if (url.pathname === '/api/jobs' && req.method === 'POST') {
                const body = await readJson(req);
                const guildId = requireGuildId(body.guildId);
                const targetUserId = firstSnowflake(body.targetUserId);
                const entireGuild = body.entireGuild !== false;
                const selectedChannelIds = parseIds(body.selectedChannelIds);
                const excludedChannelIds = parseIds(body.excludedChannelIds);
                if (!entireGuild && selectedChannelIds.length === 0) {
                    throw new HttpError(400, '非全服务器任务至少需要选择一个频道范围');
                }
                const cutoff = cutoffFromBody(body);
                const result = createJob({
                    guildId,
                    actorId: LOCAL_ACTOR,
                    targetUserId,
                    selectedChannelIds,
                    entireGuild,
                    excludedChannelIds,
                    includeThreads: body.includeThreads !== false,
                    indexOnly: body.indexOnly === true,
                    cutoffAt: cutoff.timestamp,
                    cutoffLabel: cutoff.label,
                });
                if (!result.created) {
                    if (result.clearing) throw new HttpError(409, '任务记录正在收尾，请稍后重试');
                    throw new HttpError(409, `已有未结束任务 #${result.job?.id ?? ''}`);
                }
                sendJson(res, { ok: true, message: `任务 #${result.job!.id} 已进入队列`, jobId: result.job!.id }, 201);
                return;
            }

            if (url.pathname === '/api/index/start' && req.method === 'POST') {
                const body = await readJson(req);
                const guildId = requireGuildId(body.guildId);
                const priorities = parseIds(body.priorityChannelIds);
                const result = requestGuildMessageIndex(guildId, LOCAL_ACTOR, priorities);
                if (!result.created) {
                    const channels = channelMap(guildId);
                    updateGuildIndexPriorities(
                        guildId,
                        priorities,
                        expandedPriorities(result.index.scopeChannelIds, priorities, channels),
                    );
                }
                sendJson(res, {
                    ok: true,
                    message: result.created ? '索引已进入队列' : '运行中索引的优先范围已更新',
                });
                return;
            }

            if (url.pathname === '/api/index/priorities' && req.method === 'POST') {
                const body = await readJson(req);
                const guildId = requireGuildId(body.guildId);
                const index = getGuildMessageIndex(guildId);
                if (!index) throw new HttpError(404, '尚未建立索引');
                const priorities = parseIds(body.priorityChannelIds);
                const channels = channelMap(guildId);
                updateGuildIndexPriorities(
                    guildId,
                    priorities,
                    expandedPriorities(index.scopeChannelIds, priorities, channels),
                );
                sendJson(res, { ok: true, message: `优先范围已更新为 ${priorities.length} 个` });
                return;
            }

            const indexAction = /^\/api\/index\/(pause|resume|cancel)$/.exec(url.pathname);
            if (indexAction && req.method === 'POST') {
                const body = await readJson(req);
                const guildId = requireGuildId(body.guildId);
                const changed = indexAction[1] === 'pause'
                    ? pauseGuildMessageIndex(guildId)
                    : indexAction[1] === 'resume'
                        ? resumeGuildMessageIndex(guildId)
                        : cancelGuildMessageIndex(guildId);
                const label = indexAction[1] === 'pause' ? '索引已暂停' : indexAction[1] === 'resume' ? '索引已继续' : '索引已取消';
                sendJson(res, changedResult(changed, label));
                return;
            }

            throw new HttpError(404, 'Not Found');
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            if (status === 500) console.error('[Console/Web] 请求处理失败：', error);
            sendJson(res, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            }, status);
        }
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(requestedPort, HOST, () => {
            server.off('error', onError);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('无法取得本地网页控制台监听地址');
    }
    const url = `http://${HOST}:${address.port}/?key=${encodeURIComponent(token)}`;
    let closed = false;
    return {
        port: address.port,
        url,
        close: async () => {
            if (closed) return;
            closed = true;
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        },
    };
}
