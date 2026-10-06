import test from 'node:test';
import assert from 'node:assert/strict';
import { optimize } from '../src/pipeline.js';
import { pickWinner } from '../src/conflict.js';
import { lintRecipe, lintTemplate, renderTemplate, RECIPES } from '../src/templates.js';

test('长度冲突：硬字数上限与“全面详尽”并存 → 记录冲突且不静默取舍', () => {
  const r = optimize('用表格列出要点，不超过 100 字，但要全面覆盖所有细节');
  const c = r.conflicts.find((x) => x.type === 'length');
  assert.ok(c, JSON.stringify(r.conflicts));
  assert.equal(c.action, 'flag');
  assert.equal(c.requires_confirmation, true);
  assert.ok(c.reason.length > 0);
  assert.ok(r.prompt.includes('冲突'));
});

test('必须项与禁止项自相矛盾 → include_exclude 冲突', () => {
  const r = optimize('这份说明必须包含安全性说明，不要包含安全性说明');
  assert.ok(r.conflicts.some((c) => c.type === 'include_exclude'), JSON.stringify(r.conflicts));
});

test('所有冲突都必须带 reason 与 action（INV-3：禁止静默消解）', () => {
  const r = optimize('用表格列出要点，不超过 100 字，但要全面覆盖所有细节，语气正式一点，但别太死板');
  assert.ok(r.conflicts.length >= 2, JSON.stringify(r.conflicts));
  for (const c of r.conflicts) {
    assert.ok(c.reason, JSON.stringify(c));
    assert.ok(c.action === 'flag' || c.action === 'keep_winner');
  }
  assert.equal(r.violations.length, 0, JSON.stringify(r.violations));
});

test('排序键裁决：priority 高者胜出，且与传入顺序无关', () => {
  const a = { id: 'x', priority: 100, text: 'A' };
  const b = { id: 'x', priority: 40, text: 'B' };
  assert.equal(pickWinner(a, b).text, 'A');
  assert.equal(pickWinner(b, a).text, 'A');
  assert.equal(pickWinner({ id: 'x', priority: 10, hash: 'aaaa', text: 'A' }, { id: 'x', priority: 10, hash: 'bbbb', text: 'B' }).text, 'A');
});

test('翻译指令不算语言冲突（源语言≠要求两种输出语言），但真正的双语要求仍须报冲突', () => {
  const t = optimize('把这段中文翻译成英文，保持专业术语');
  assert.equal(t.conflicts.some((c) => c.type === 'language'), false, JSON.stringify(t.conflicts));
  assert.ok(t.prompt.includes('输出语言：English'), t.prompt);
  assert.equal(t.ir.slots.language.value, 'en');

  const both = optimize('摘要用英文写，但正文用中文');
  assert.ok(both.conflicts.some((c) => c.type === 'language'), JSON.stringify(both.conflicts));
});

test('模板 lint：空洞章节与缺失变量会被拦下', () => {
  assert.deepEqual(lintRecipe(RECIPES['fast/default']), []);
  assert.ok(lintRecipe({ id: 'bad', sections: ['nope'] }).length > 0);
  assert.ok(lintRecipe({ id: 'bad2', sections: [] }).length > 0);
  assert.equal(renderTemplate('你好 {{name}}', { name: '世界' }), '你好 世界');
  assert.throws(() => renderTemplate('你好 {{name}}', {}), /模板变量缺失/);
  assert.ok(lintTemplate('这个模板没有变量').length > 0);
  assert.deepEqual(lintTemplate('{{a}} 和 {{b}}'), []);
});
