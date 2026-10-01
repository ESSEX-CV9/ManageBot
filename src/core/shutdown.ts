import type { Client } from 'discord.js';

interface ShutdownOptions {
    client: Pick<Client, 'destroy'>;
    cleanup: (deadlineAt: number) => Promise<void>;
    processControl?: Pick<NodeJS.Process, 'on' | 'exit'>;
    timeoutMs?: number;
}

export function installGracefulShutdown({ client, cleanup, processControl = process, timeoutMs = 30000 }: ShutdownOptions): (signal: string, exitCode?: number) => Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('退出超时必须为有效的正整数毫秒数。');
    let shutdownTask: Promise<void> | undefined;
    let requestedExitCode = 0;
    let exited = false;
    function exitOnce(): void {
        if (exited) return;
        exited = true;
        processControl.exit(requestedExitCode);
    }
    function shutdown(signal: string, exitCode = 0): Promise<void> {
        requestedExitCode = Math.max(requestedExitCode, exitCode);
        if (shutdownTask) return shutdownTask;
        shutdownTask = (async () => {
            console.log(`🛑 收到 ${signal}，正在保存对局并退出。`);
            const deadlineAt = Date.now() + timeoutMs;
            const deadline = setTimeout(() => {
                console.error('❌ 退出收尾超时。');
                requestedExitCode = 1;
                exitOnce();
            }, timeoutMs);
            deadline.unref();
            try {
                try { await cleanup(deadlineAt); }
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
            exitOnce();
        })();
        return shutdownTask;
    }
    for (const signal of ['SIGTERM', 'SIGINT']) {
        processControl.on(signal, () => { void shutdown(signal); });
    }
    return shutdown;
}
