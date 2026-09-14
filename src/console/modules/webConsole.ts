import type { ConsoleContext, ConsoleModule } from '../types';
import { startLocalControlServer } from '../web/localControlServer';

function configuredPort(): number {
    const raw = process.env.MANAGE_CONSOLE_PORT?.trim();
    if (!raw) return 3210;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : 3210;
}

async function run(context: ConsoleContext): Promise<void> {
    context.clear();
    console.log('Manage Bot · 本地网页控制台');
    console.log('═'.repeat(52));
    console.log('正在启动仅限本机访问的网页服务……');

    let handle: Awaited<ReturnType<typeof startLocalControlServer>> | null = null;
    try {
        handle = await startLocalControlServer(configuredPort());
        console.log(`\n访问地址：${handle.url}`);
        console.log('\n此地址包含本次运行的临时访问密钥，请不要转发。');
        console.log('Bot 主进程需要同时运行，网页创建的任务才会被后台执行。');
        await context.pause('网页服务正在运行；按 Enter 关闭网页服务并返回主菜单...');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await context.pause(`网页服务启动失败：${message}\n按 Enter 返回主菜单...`);
    } finally {
        await handle?.close().catch(error => {
            console.error('关闭网页服务失败：', error);
        });
    }
}

const webConsole: ConsoleModule = {
    id: 'web-console',
    title: '本地网页控制台',
    description: '在浏览器中操作并实时查看任务与索引进度',
    run,
};

export default webConsole;
