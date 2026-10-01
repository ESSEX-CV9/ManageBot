import type { Client } from 'discord.js';

interface ShutdownOptions {
    client: Pick<Client, 'destroy'>;
    cleanup: () => Promise<void>;
    processControl?: Pick<NodeJS.Process, 'on' | 'exit'>;
    timeoutMs?: number;
}

export function installGracefulShutdown({ client, cleanup, processControl = process, timeoutMs = 10000 }: ShutdownOptions): (signal: string, exitCode?: number) => Promise<void> {
    let shutdownTask: Promise<void> | undefined;
    let requestedExitCode = 0;
    function shutdown(signal: string, exitCode = 0): Promise<void> {
        requestedExitCode = Math.max(requestedExitCode, exitCode);
        if (shutdownTask) return shutdownTask;
        shutdownTask = (async () => {
            console.log(`🛑 收到 ${signal}，正在保存对局并退出。`);
            const deadline = setTimeout(() => {
                console.error('❌ 退出收尾超时。');
                processControl.exit(1);
            }, timeoutMs);
            deadline.unref();
            try {
                try { await cleanup(); }
                catch (error) {
                    requestedExitCode = 1;
                    console.error('❌ 退出收尾失败：', error);
                }
                try { await client.destroy(); }
                catch (error) {
                    requestedExitCode = 1;
                    console.error('❌ 断开 Discord 失败：', error);
                }
            } finally {
                clearTimeout(deadline);
            }
            processControl.exit(requestedExitCode);
        })();
        return shutdownTask;
    }
    for (const signal of ['SIGTERM', 'SIGINT']) {
        processControl.on(signal, () => { void shutdown(signal); });
    }
    return shutdown;
}
