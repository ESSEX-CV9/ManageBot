// src/modules/template/services/templateScheduler.ts
//
// 模版模块的后台定时任务示例。
// 推荐写法：导出一个 startXxx(client) 函数，在 clientReady 后由核心调用。

import type { Client } from 'discord.js';
import { getCheckIntervals } from '../../../core/config/timeconfig';
import { countRecords } from './templateDatabase';

let timer: NodeJS.Timeout | null = null;

/**
 * 启动模版模块的后台调度器。
 * 间隔从 core/config/timeconfig.ts 的 getCheckIntervals().templateCheck 读取，
 * 便于在测试/生产模式下统一切换节奏。
 */
export function startTemplateScheduler(client: Client): void {
    // 避免重复启动
    if (timer) return;

    const intervalMs = getCheckIntervals().templateCheck;

    timer = setInterval(() => {
        try {
            // 这里放你的周期性逻辑。示例仅打印一条“心跳”日志。
            for (const guild of client.guilds.cache.values()) {
                const total = countRecords(guild.id);
                if (total > 0) {
                    console.log(`[Template] 💓 心跳：服务器 ${guild.name} 现有 ${total} 条计数记录。`);
                }
            }
        } catch (err) {
            console.error('[Template] 调度器执行出错:', err);
        }
    }, intervalMs);

    // 让定时器不要阻止进程退出
    timer.unref?.();

    console.log(`[Template] ⏱️ 调度器已启动（间隔 ${Math.round(intervalMs / 1000)} 秒）。`);
}
