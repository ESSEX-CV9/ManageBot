// src/core/index.ts
//
// 机器人主入口。职责：
//   1. 创建 Discord 客户端 + 诊断日志
//   2. 注册所有斜杠命令到 client.commands
//   3. 绑定事件（ClientReady / InteractionCreate / MessageCreate 等）
//   4. 在 ClientReady 里同步命令并启动各模块的后台系统
//
// 接入新模块：仿照下方「模版模块」的三处标记（① import、② 注册命令、③ 启动系统）。

import 'dotenv/config';
// 代理必须在 discord.js 之前引入：这样才能在网关库捕获 ws.WebSocket 之前完成打补丁。
import { proxyAgent } from './proxy';
import { Client, Collection, Events, GatewayIntentBits } from 'discord.js';

import { clientReadyHandler } from './events/clientReady';
import { interactionCreateHandler } from './events/interactionCreate';
import { messageCreateHandler } from './events/messageCreate';
import { printTimeConfig } from './config/timeconfig';
import type { Command } from './types';

// 共享命令
import pingCommand from '../shared/commands/ping';
import setCheckChannelCommand from '../shared/commands/setCheckChannel';
// import debugPermissionsCommand from '../shared/commands/debugPermissions'; // 需要调试权限时取消注释

// 1. 模版模块 —— 复制这一块来接入你自己的模块
import templateCommand from '../modules/template/commands/templateCommand';
import { startTemplateSystem } from '../modules/template';

// 2. 募选模块
import electionCommand from '../modules/election/commands/electionCommand';
import electionTestCommand from '../modules/election/commands/electionTestCommand';
import { startElectionSystem } from '../modules/election';
import { isElectionTestMode } from '../modules/election/services/electionPermission';

// 3. 论坛帖子标题统计模块
import forumTitleExportCommand from '../modules/forumTitleExport/commands/forumTitleExportCommand';

// 4. 标题与 TAG 规范模块
import titleGuardCommand from '../modules/titleGuard/commands/titleGuardCommand';
import { startTitleGuardSystem } from '../modules/titleGuard';

// 5. 分管身份组轮替模块
import roleRotationCommand from '../modules/roleRotation/commands/roleRotationCommand';
import callFrogCommand from '../modules/roleRotation/commands/callFrogCommand';
import {
    handleRoleRotationMemberRemove,
    handleRoleRotationMemberUpdate,
    startRoleRotationSystem,
} from '../modules/roleRotation';

// 6. 紧急消息冲水模块
import messageCleanupCommand from '../modules/messageCleanup/commands/messageCleanupCommand';
import { startMessageCleanupSystem } from '../modules/messageCleanup';

// --- 进程级兜底日志（避免“无响应但控制台无日志”难以排查） ---
const FATAL_EXIT_ON_EXCEPTION = String(process.env.FATAL_EXIT_ON_EXCEPTION || '').toLowerCase() === 'true';

process.on('unhandledRejection', (reason) => {
    console.error('❌ [Process] unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ [Process] uncaughtException:', err);
    if (FATAL_EXIT_ON_EXCEPTION) {
        process.exit(1);
    }
});

const DISCORD_REST_TIMEOUT_MS = (() => {
    const n = Number(process.env.DISCORD_REST_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : 15000;
})();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
    ],
    rest: {
        timeout: DISCORD_REST_TIMEOUT_MS,
        // 关键：把代理显式交给 discord.js 的 REST（它不认 undici 全局 dispatcher）。
        // 未配置代理时 proxyAgent 为 null，即默认直连。
        agent: proxyAgent,
    },
});

// --- Discord 客户端/REST 诊断日志 ---
client.on('error', (err) => console.error('❌ [Discord] client error:', err));
client.on('warn', (info) => console.warn('⚠️ [Discord] client warn:', info));
client.on('shardError', (err, shardId) => console.error(`❌ [Discord] shardError shard=${shardId}:`, err));
client.on('shardDisconnect', (event, shardId) => console.warn(`⚠️ [Discord] shardDisconnect shard=${shardId} code=${event?.code} reason=${event?.reason}`));

try {
    client.rest.on('rateLimited', (info) => {
        const route = info?.route || 'unknown';
        const method = info?.method || 'unknown';
        console.warn(`⚠️ [Discord][REST] rateLimited ${method} ${route} resetInMs=${info?.timeToReset}`);
    });
} catch {
    /* ignore */
}

const HEALTH_LOG_INTERVAL_MINUTES = Number(process.env.HEALTH_LOG_INTERVAL_MINUTES || 0);
if (Number.isFinite(HEALTH_LOG_INTERVAL_MINUTES) && HEALTH_LOG_INTERVAL_MINUTES > 0) {
    setInterval(() => {
        console.log(
            `[Health] wsStatus=${client.ws?.status} ping=${client.ws?.ping} guilds=${client.guilds?.cache?.size} mem=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
        );
    }, Math.floor(HEALTH_LOG_INTERVAL_MINUTES * 60 * 1000));
}

client.commands = new Collection<string, Command>();

// 共享命令
client.commands.set(pingCommand.data.name, pingCommand);
client.commands.set(setCheckChannelCommand.data.name, setCheckChannelCommand);
// client.commands.set(debugPermissionsCommand.data.name, debugPermissionsCommand); // 需要调试权限时取消注释

// 1. 模版模块命令注册
client.commands.set(templateCommand.data.name, templateCommand);

// 2. 募选模块命令注册
client.commands.set(electionCommand.data.name, electionCommand);

// 3. 论坛帖子标题统计模块命令注册
client.commands.set(forumTitleExportCommand.data.name, forumTitleExportCommand);

// 4. 标题与 TAG 规范模块命令注册
client.commands.set(titleGuardCommand.data.name, titleGuardCommand);

// 5. 分管身份组轮替模块命令注册
client.commands.set(roleRotationCommand.data.name, roleRotationCommand);
client.commands.set(callFrogCommand.data.name, callFrogCommand);

// 6. 紧急消息冲水命令注册
client.commands.set(messageCleanupCommand.data.name, messageCleanupCommand);

// 测试命令仅在测试模式下注册（生产环境不会出现 /募选测试）
if (isElectionTestMode()) {
    client.commands.set(electionTestCommand.data.name, electionTestCommand);
    console.log('🧪 募选测试命令已启用（ELECTION_TEST_MODE=true）');
}

client.once(Events.ClientReady, async (readyClient) => {
    try {
        // 启动时同步命令（内部会执行 rest.put 刷新各服务器命令）
        await clientReadyHandler(readyClient);
    } catch (err) {
        console.error('❌ 启动阶段命令同步失败，进程即将退出：', err);
        try {
            readyClient.destroy();
        } catch {
            /* ignore */
        }
        process.exit(1);
        return;
    }

    printTimeConfig();

    // ③ 启动各模块的后台系统
    await startTemplateSystem(readyClient);
    await startElectionSystem(readyClient);
    await startTitleGuardSystem(readyClient);
    await startRoleRotationSystem(readyClient);
    await startMessageCleanupSystem(readyClient);

    console.log('\n🤖 机器人已完全启动，所有系统正常运行！');
});

client.on(Events.InteractionCreate, interactionCreateHandler);
client.on(Events.MessageCreate, messageCreateHandler);
client.on(Events.GuildMemberUpdate, handleRoleRotationMemberUpdate);
client.on(Events.GuildMemberRemove, handleRoleRotationMemberRemove);

function normalizeDiscordToken(raw: string | undefined): string {
    if (!raw) return '';
    let token = String(raw).trim();
    if (!token) return '';
    // 兼容误填 "Bot <token>"
    token = token.replace(/^Bot\s+/i, '').trim();
    return token;
}

const token = normalizeDiscordToken(process.env.DISCORD_TOKEN);
// 仅检查是否为空/占位符；不再对 token 结构做强制格式校验，
// 交由 Discord 登录环节判定，避免将来官方改动 token 格式时误拦合法 token。
if (!token || token.includes('PASTE_YOUR_DISCORD_BOT_TOKEN')) {
    console.error('❌ 缺少或未正确配置 DISCORD_TOKEN。请在项目根目录 .env 中设置 DISCORD_TOKEN=你的机器人Token 后重启。');
    process.exit(1);
}

// 确保后续模块（如命令同步）拿到的是清洗后的 token
process.env.DISCORD_TOKEN = token;

// 网络类错误的常见 code/name（连不上 Discord，多为 DNS 污染/被墙/代理未开或端口错误）
const NETWORK_ERROR_CODES = new Set([
    'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET',
    'EHOSTUNREACH', 'ENETUNREACH', 'EPROTO', 'UND_ERR_CONNECT_TIMEOUT', 'ConnectTimeoutError',
]);

function isNetworkError(err: unknown): boolean {
    const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown } | null;
    if (!e) return false;
    const code = String(e.code ?? '');
    const name = String(e.name ?? '');
    if (NETWORK_ERROR_CODES.has(code) || NETWORK_ERROR_CODES.has(name)) return true;
    // 递归看 cause（undici 常把底层网络错误包在 cause 里）
    if (e.cause && isNetworkError(e.cause)) return true;
    return /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|connect timeout|fetch failed|proxy/i
        .test(String(e.message ?? ''));
}

client.login(token).catch((err) => {
    const code = String((err as { code?: unknown })?.code ?? '');

    if (isNetworkError(err)) {
        console.error('❌ 无法连接到 Discord（这是网络问题，不是 Token 问题）。');
        console.error('   可能原因与解决办法：');
        console.error('   • 本机无法直连 Discord（DNS 污染/被墙）：请在 .env 配置 PROXY_URL（如 http://127.0.0.1:7890），或开启代理软件的全局/TUN 模式后重试。');
        console.error('   • 已配置代理但仍失败：检查代理端口是否正确、代理软件是否已启动。');
    } else if (code === 'TokenInvalid' || code === 'TokenMissing') {
        console.error('❌ Token 无效：Discord 拒绝了该 Token。请检查是否粘贴错误 / 已被重置 / 使用了非 Bot Token。');
    } else {
        console.error('❌ Discord 登录失败（未归类错误，详见下方堆栈）。');
    }

    console.error(err);
    process.exit(1);
});
