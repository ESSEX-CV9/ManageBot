// src/modules/titleGuard/events/threadEvents.ts
//
// 触发时机（设计文档 §10）：
//   ThreadCreate —— 新帖发布
//   ThreadUpdate —— 标题或 TAG 变化
//
// 两条注意：
//   1. 新帖刚发出来时作者常常还在补 TAG，所以延迟一小会儿再检测，避免误报。
//   2. 宽限期内作者又改标题：重新判定，但**不重置倒计时**——防止靠反复小改拖时间。

import type { ThreadChannel } from 'discord.js';

import * as db from '../services/titleGuardDatabase';
import { effectiveViolations, inspectThread, isForumThread, openCaseFor } from '../services/enforcer';
import { refreshNotice } from '../components/noticePanel';
import { buildResolvedMessage } from '../services/noticeContent';

/** 新帖发布后等一会儿再查，给作者补 TAG 的时间 */
const NEW_THREAD_DELAY_MS = 60_000;

const pending = new Set<string>();

function scheduleCheck(thread: ThreadChannel, delayMs: number): void {
    if (pending.has(thread.id)) return;
    pending.add(thread.id);

    setTimeout(() => {
        pending.delete(thread.id);
        void checkThread(thread).catch(err =>
            console.error(`[TitleGuard] 检查帖子 ${thread.id} 出错：`, err),
        );
    }, delayMs);
}

async function checkThread(thread: ThreadChannel): Promise<void> {
    const settings = db.getSettings(thread.guild.id);
    if (!settings.enabled) return;

    const inspection = await inspectThread(thread);
    if (inspection.skipped) return;

    const violations = effectiveViolations(inspection);
    const openCase = db.getOpenCase(thread.id);

    // 已经合规了：关掉未结案件，并把原通知改口成「已结束」
    // （只撤按钮不够，正文还写着「请在期限前修改」）
    if (violations.length === 0) {
        if (openCase) {
            db.closeCase(openCase.id, 'resolved');
            await refreshNotice(thread.client, openCase.id);
            await thread.send({ content: buildResolvedMessage() }).catch(() => { /* 忽略 */ });
        }
        return;
    }

    // 已有未结案件：更新违规内容和方案，但**保留原来的截止时间**
    if (openCase) {
        db.updateCase(openCase.id, { violations, plan: inspection.plan });
        return;
    }

    const created = openCaseFor(inspection);
    if (created) {
        console.log(`[TitleGuard] 新建案件 #${created.id}：${thread.name}`);
    }
}

export async function titleGuardThreadCreate(thread: ThreadChannel): Promise<void> {
    if (!isForumThread(thread)) return;
    scheduleCheck(thread, NEW_THREAD_DELAY_MS);
}

export async function titleGuardThreadUpdate(
    oldThread: ThreadChannel,
    newThread: ThreadChannel,
): Promise<void> {
    if (!isForumThread(newThread)) return;

    const titleChanged = oldThread.name !== newThread.name;
    const tagsChanged =
        oldThread.appliedTags.length !== newThread.appliedTags.length ||
        oldThread.appliedTags.some(id => !newThread.appliedTags.includes(id));

    if (!titleChanged && !tagsChanged) return;

    // 改动后短暂等待，避免作者连续改几次触发多轮检测
    scheduleCheck(newThread, 15_000);
}
