// src/core/proxy.ts
//
// 代理支持：当 .env 配置了代理地址时，让 REST 和网关 WebSocket 都走代理。
// 适用于本机无法直连 Discord（DNS 污染/被墙）的网络环境。
//
// ⚠️ 重要 1：本文件必须在 `import 'discord.js'` 之前被引入（见 core/index.ts 的 import 顺序），
//    因为要在 @discordjs/ws 捕获 `ws.WebSocket` 引用之前，先把 ws 的 WebSocket 换成带代理的版本。
//
// ⚠️ 重要 2：node_modules 里可能存在多份 undici（顶层一份、@discordjs/rest 自带一份）。
//    不同副本的 ProxyAgent 互不认账——用副本 A 造的 ProxyAgent 交给副本 B 的 request()，会被忽略、直连。
//    所以这里必须用【@discordjs/rest 实际使用的那份 undici】来构造 ProxyAgent。
//
// 读取的环境变量（任一即可）：PROXY_URL / HTTPS_PROXY / HTTP_PROXY
// 例如 Clash 默认：PROXY_URL=http://127.0.0.1:7890

import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl =
    process.env.PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';

/** 代理地址（未配置时为空串） */
export const PROXY_URL = proxyUrl;

/**
 * 解析 discord.js REST（@discordjs/rest）实际使用的那份 undici，
 * 保证据此构造的 ProxyAgent 与其内部 request() 兼容。
 */
function resolveRestUndici(): any {
    const dirs: string[] = [];
    for (const pkg of ['@discordjs/rest', 'discord.js']) {
        try {
            dirs.push(path.dirname(require.resolve(pkg)));
        } catch {
            /* 解析不到就跳过 */
        }
    }
    for (const dir of dirs) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            return require(require.resolve('undici', { paths: [dir] }));
        } catch {
            /* 换下一个候选目录 */
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('undici'); // 兜底：顶层 undici
}

function createProxyAgent(url: string): any {
    const undici = resolveRestUndici();
    const agent = new undici.ProxyAgent(url);
    // 全局兜底：覆盖任何走该副本全局 dispatcher 的请求。
    try {
        undici.setGlobalDispatcher(agent);
    } catch {
        /* ignore */
    }
    return agent;
}

/**
 * 供 discord.js REST 使用的 undici 代理 dispatcher（未配置代理时为 null）。
 * 由 core/index.ts（client 的 rest.agent）与 core/events/clientReady.ts（独立 REST 的 setAgent）显式使用。
 */
export const proxyAgent: any = proxyUrl ? createProxyAgent(proxyUrl) : null;

if (proxyUrl) {
    // 网关 WebSocket（Node 环境下 @discordjs/ws 使用 ws 包）：
    // ws 支持 options.agent，但 discord.js 没暴露注入口，故替换 ws 导出的 WebSocket 类，
    // 在其构造时补上代理 agent。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wsModule = require('ws') as { WebSocket: new (...args: any[]) => object };
    const OriginalWebSocket: new (...args: any[]) => object = wsModule.WebSocket;
    const wsAgent = new HttpsProxyAgent(proxyUrl);

    class ProxiedWebSocket extends OriginalWebSocket {
        constructor(...args: any[]) {
            const [address, protocols, options] = args;
            super(address, protocols, { ...(options ?? {}), agent: wsAgent });
        }
    }
    wsModule.WebSocket = ProxiedWebSocket;

    console.log(`🌐 已启用代理（REST + 网关）：${proxyUrl}`);
}
