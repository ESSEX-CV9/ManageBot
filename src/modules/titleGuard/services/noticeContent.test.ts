import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNoticeContent, type NoticeInput } from './noticeContent';

const BASE: NoticeInput = {
    authorId: '123',
    originalTitle: '测试标题',
    newTitle: '测试标题',
    titleChanged: false,
    violations: [],
    removeTagNames: [],
    addTagNames: [],
    keepGroup: null,
    keepSource: 'none',
    autoFixable: true,
    blockedReason: null,
    deadline: Date.now() + 60_000,
    isOldPost: false,
};

test('未复核的通知会提示可调用 LLM 再次复核', () => {
    // 即使建案时已经由 AI 判过，仍应展示额外一次 AI 申诉复核机会。
    const content = buildNoticeContent({ ...BASE, llmReason: '建案时由 AI 定性' });
    assert.match(content.description, /如果认为判定有误，可以点击复核按钮调用 LLM 再次复核。/);
    assert.ok(content.buttons.some(b => b.label === '申请复核'));
});

test('AI 复核用过后切换为人工复核提示', () => {
    const content = buildNoticeContent({
        ...BASE,
        review: { upheld: true, reason: '维持原判' },
    });
    assert.doesNotMatch(content.description, /调用 LLM 再次复核/);
    assert.match(content.footer, /人工复核/);
    assert.ok(content.buttons.some(b => b.label === '申请人工复核'));
});

test('AI 复核已占用但尚无结论时不再提示调用 LLM', () => {
    const content = buildNoticeContent({
        ...BASE,
        aiReviewUsed: true,
    });
    assert.doesNotMatch(content.description, /调用 LLM 再次复核/);
    assert.match(content.footer, /人工复核/);
    assert.ok(content.buttons.some(b => b.label === '申请人工复核'));
});
