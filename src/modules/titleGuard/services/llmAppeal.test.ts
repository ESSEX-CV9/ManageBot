import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewSpec, type AppealReviewInput } from './llmAppeal';

function input(bodyExcerpt?: string): AppealReviewInput {
    return {
        title: '【纯爱】测试标题',
        forumName: '测试论坛',
        bodyExcerpt,
        tags: [{ name: 'NTR', group: 'NTR' }],
        hits: [{ word: '纯爱', group: '纯爱', where: '标签区' }],
        violationMessages: ['标题分类与 TAG 冲突'],
        plan: {
            titleChanged: false,
            newTitle: '【纯爱】测试标题',
            removeTagNames: ['NTR'],
            addTagNames: ['纯爱'],
        },
        priorReason: null,
        appealText: 'TAG 是我点错了，标题分类才是正确的。',
    };
}

test('首次 AI 复核会把获准发送的首楼摘录放进提示词', () => {
    const spec = buildReviewSpec(input('这是首楼正文，用于说明作品实际分类。'));
    assert.match(spec.userPrompt, /首楼摘录/);
    assert.match(spec.userPrompt, /这是首楼正文，用于说明作品实际分类/);
    assert.ok(
        spec.userPrompt.indexOf('首楼摘录') < spec.userPrompt.indexOf('作者提交的申诉理由'),
        '首楼和申诉理由都应放在最终任务重述之前，并明确按不可信资料处理',
    );
});

test('论坛未授权发送首楼时，AI 复核提示词不包含首楼区块', () => {
    const spec = buildReviewSpec(input());
    assert.doesNotMatch(spec.userPrompt, /首楼摘录/);
});
