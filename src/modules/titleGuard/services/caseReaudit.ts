// src/modules/titleGuard/services/caseReaudit.ts
//
// 未结案件的后台重审核。
//
// 这不是作者点击「申请复核」的申诉流程：这里绝不读写 aiReviewUsed、appealText
// 等字段，也不会往帖子里发送消息。它只按帖子当前标题/TAG 重新生成案件方案，
// 原地刷新已有通知；确认无需整改时静默结案。

import type { Client, ThreadChannel } from 'discord.js';

import { refreshNotice } from '../components/noticePanel';
import * as db from './titleGuardDatabase';
import {
    effectiveViolations,
    fetchThread,
    inspectThread,
} from './enforcer';
import { summarizeJudgement } from './llmJudge';

/** 纯规则很快，可以一轮多跑几条；LLM 一轮只跑一条。 */
const RULE_BATCH_SIZE = 10;
const TICK_BUDGET_MS = 45_000;
const activeCases = new Set<number>();

export type CaseReauditOutcome = 'updated' | 'released' | 'unchanged';

export interface ImmediateCaseReauditResult {
    ok: boolean;
    outcome?: CaseReauditOutcome;
    message: string;
}

function tagsUnchanged(before: string[], thread: ThreadChannel): boolean {
    return before.length === thread.appliedTags.length
        && before.every(id => thread.appliedTags.includes(id));
}

async function closeAsCompliant(
    client: Client,
    guardCase: db.GuardCase,
    thread: ThreadChannel,
    plan: unknown,
    llmReason: string | null,
): Promise<void> {
    db.updateCase(guardCase.id, {
        originalTitle: thread.name,
        originalTagIds: [...thread.appliedTags],
        violations: [],
        plan,
        llmReason,
    });
    db.closeCase(guardCase.id, 'resolved');
    if (thread.parentId) db.markClean(guardCase.guildId, thread.parentId, [thread.id]);
    await refreshNotice(client, guardCase.id);
}

async function reauditOne(
    client: Client,
    item: Pick<db.CaseReauditItem, 'caseId' | 'mode'>,
): Promise<{ outcome: CaseReauditOutcome; message: string }> {
    const guardCase = db.getCase(item.caseId);
    if (!guardCase || guardCase.closedAt !== null) {
        return { outcome: 'unchanged', message: '案件已经结案，无需重审核。' };
    }

    const thread = await fetchThread(client, guardCase.threadId);
    if (!thread) throw new Error('找不到帖子，或机器人已无权读取');

    // LLM 可能要几十秒。期间作者如果改了标题/TAG，这一轮结果已经过期，
    // 直接放回队列按新内容再算，不能拿旧输入覆盖新状态。
    const titleBefore = thread.name;
    const tagsBefore = [...thread.appliedTags];
    const useLlm = item.mode === 'llm';
    const inspection = await inspectThread(thread, useLlm
        ? { forceModel: true, bypassLlmCache: true }
        : { dryRun: true });

    const latest = await thread.fetch(true);
    if (latest.name !== titleBefore || !tagsUnchanged(tagsBefore, latest)) {
        throw new Error('重审核期间帖子内容发生变化，将按最新内容重试');
    }

    // 已人工豁免的漏网案件可以直接收口；论坛停用等其它跳过原因不替管理组结案。
    if (inspection.skipped) {
        if (inspection.skipped === '已被管理组豁免') {
            db.closeCase(guardCase.id, 'exempt');
            await refreshNotice(client, guardCase.id);
            return { outcome: 'released', message: '当前标题已被豁免，案件已静默结案。' };
        }
        return { outcome: 'unchanged', message: `未修改案件：${inspection.skipped}。` };
    }

    const violations = effectiveViolations(inspection);
    const llmReason = useLlm
        ? summarizeJudgement(inspection.judgement)
        : null;

    // 规则确认没有问题，或者 LLM 认定无需整改：静默放行，只改原通知。
    if (violations.length === 0) {
        await closeAsCompliant(client, guardCase, thread, inspection.plan, llmReason);
        return { outcome: 'released', message: '重审核确认当前帖子无需整改，案件已静默结案。' };
    }

    // 纯规则重审碰到语义问题或「本论坛所有问题先经模型」时，旧方案原样保留。
    // 自动启动绝不能用一份还在等待模型的半成品覆盖已经通知给作者的方案。
    if (!useLlm && inspection.llmPending) {
        return {
            outcome: 'unchanged',
            message: '此案需要语义判断，纯规则重审未覆盖原方案；可改用立即 LLM 重审。',
        };
    }

    if (useLlm && inspection.llmPending) {
        throw new Error('LLM 未能给出重审核结论');
    }
    if (!inspection.plan) throw new Error('未能生成整改方案');

    db.unmarkClean(guardCase.guildId, guardCase.threadId);
    db.updateCase(guardCase.id, {
        originalTitle: thread.name,
        originalTagIds: [...thread.appliedTags],
        violations,
        plan: inspection.plan,
        llmReason,
        // state、deadline、申诉和 AI 复核字段一律保留。
    });
    await refreshNotice(client, guardCase.id);
    return { outcome: 'updated', message: '已按帖子当前标题和 TAG 更新整改方案及原通知。' };
}

/**
 * 管理员指定单个案件立即重审核。与批量任务共用同一套逻辑，但不等待调度周期。
 */
export async function reauditCaseNow(
    client: Client,
    guildId: string,
    caseId: number,
    mode: db.CaseReauditMode,
): Promise<ImmediateCaseReauditResult> {
    const guardCase = db.getCase(caseId);
    if (!guardCase || guardCase.guildId !== guildId) {
        return { ok: false, message: '找不到本服务器的这个案件。' };
    }
    if (guardCase.closedAt !== null) {
        return { ok: false, message: '这个案件已经结案。' };
    }
    if (activeCases.has(caseId)) {
        return { ok: false, message: '这个案件正在重审核，请稍后再试。' };
    }

    activeCases.add(caseId);
    try {
        const result = await reauditOne(client, { caseId, mode });
        db.discardCaseReaudit(caseId, mode);
        return { ok: true, ...result };
    } catch (err) {
        return {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
        };
    } finally {
        activeCases.delete(caseId);
    }
}

/**
 * 每个调度周期处理一小批。LLM 任务优先且一轮只跑一个，避免拖住到期处置。
 */
export async function runCaseReauditTick(client: Client): Promise<void> {
    const deadline = Date.now() + TICK_BUDGET_MS;
    let rulesProcessed = 0;

    while (Date.now() < deadline && rulesProcessed < RULE_BATCH_SIZE) {
        const item = db.claimNextCaseReaudit();
        if (!item) return;

        // 单案立即重审已经先拿到内存锁：把批量任务原样放回，下轮再看。
        if (activeCases.has(item.caseId)) {
            db.deferCaseReaudit(item.caseId);
            return;
        }

        activeCases.add(item.caseId);
        try {
            await reauditOne(client, item);
            db.finishCaseReaudit(item.caseId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            db.failCaseReaudit(item.caseId, message);
            console.warn(`[TitleGuard] 后台重审核案件 #${item.caseId} 失败：${message}`);
        } finally {
            activeCases.delete(item.caseId);
        }

        if (item.mode === 'llm') return;
        rulesProcessed++;
    }
}
