import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineSurvey, withBaseline } from './baseline.js';
import { aiPrompt, buildFacts, checkAiPlan, QUADRANTS, ruleActions, ruleBrief } from './actions.js';
import { askModels } from './ai.js';
import { createPreElectionRepository } from './repository.js';

// The rule tests run on the built-in data without the APC member list: with it, almost every
// polling unit has a member, so the "no ground team" rules they exercise would have nothing to fire on.
const withoutMembers = () => withBaseline([]).filter((item) => item.kind !== 'members');
const state = () => buildFacts({ datasets: withoutMembers(), survey: baselineSurvey() });

test('with the APC member list, the facts report its coverage', () => {
  const { facts } = buildFacts({ datasets: withBaseline([]), survey: baselineSurvey() });
  assert.match(facts.find((fact) => fact.id === 'M1').fact, /157,289 people; they cover 5,992 of 6,390 polling units/);
});

test('facts carry the figures from the pulse and the map, each with an id', () => {
  const { facts } = state();
  const byId = Object.fromEntries(facts.map((fact) => [fact.id, fact.fact]));
  assert.equal(byId.M1, undefined, 'no member list, no member fact');
  assert.match(byId.C1, /443 still open \(37%\); 82 asked for a follow-up; 343 dropped/);
  assert.match(byId.G1, /No members in Ibadan North.*6,390 polling units and 3,276,307 registered voters/);
  assert.match(byId.G2, /Iseyin \(Sen\. Alli 64%\)/);
  assert.ok(facts.every((fact) => !/0[789]\d{9}/.test(fact.fact)), 'no phone numbers in facts');
});

test('rules fill all four quadrants with stable keys, evidence and due dates', () => {
  const plan = ruleActions(state(), { horizon: 'week', now: new Date('2026-09-25T09:00:00Z') });
  for (const quadrant of QUADRANTS) assert.ok(plan[quadrant].length > 0, quadrant);
  const first = plan.do_now[0];
  assert.equal(first.key, 'rule:ground-empty');
  assert.equal(first.owner, 'Field operations');
  assert.equal(first.due, 'by 2 Oct');
  assert.deepEqual(first.evidence, ['G1', 'G2']);
  assert.ok(plan.reduce.some((action) => /Call confirmed supporters less/.test(action.title)));
  assert.equal(ruleActions(state(), { horizon: 'election' }).do_now[0].due, 'within 2 weeks', 'urgent work stays near-term even on the long horizon');
  assert.equal(ruleActions(state(), { horizon: 'election' }).plan[0].due, 'before election day');
  assert.match(ruleBrief(state()).focus, /^Start with: build ground teams in Ibadan North/);
});

test('an LGA scope gets LGA and ward actions', () => {
  const facts = buildFacts({ datasets: withoutMembers(), survey: baselineSurvey(), lga: 'Iseyin' });
  const plan = ruleActions(facts);
  assert.equal(plan.do_now[0].title, 'Build a ground team across all 11 wards of Iseyin');
  assert.ok(plan.do_now.some((action) => action.key === 'rule:lga-no-calls'));
});

test('the AI prompt holds the rules and only the facts', () => {
  const facts = state().facts;
  const prompt = aiPrompt(facts, { place: 'All of Oyo', horizon: 'fortnight' });
  assert.match(prompt, /HORIZON: Next 2 weeks/);
  assert.match(prompt, /Never suggest paying or giving gifts for votes/);
  assert.match(prompt, /"id": "G1"/);
});

test('AI plans are checked: unknown evidence dropped, invented figures flagged, junk rejected', () => {
  const facts = [{ id: 'G1', fact: 'No members in Iseyin: 229 polling units and 109,179 registered voters.' }, { id: 'C1', fact: '443 still open (37%).' }];
  const answer = JSON.stringify({
    brief: { where_we_stand: 'Ground is thin.', focus: 'Staff Iseyin.' },
    quadrants: {
      do_now: [
        { title: 'Recruit 229 agents in Iseyin', why: '109,179 voters have nobody.', where: ['Iseyin'], owner: 'Field operations', due: 'by 2 Oct', target: '229 agents', evidence: ['G1', 'X9'] },
        { title: 'Clear 443 open calls', why: 'Backlog of 443 (37%).', owner: 'Contact center', evidence: ['C1'] },
      ],
      plan: [{ title: 'Win 55,000 new voters', why: 'Aim high.', owner: 'Someone', evidence: [] }],
      delegate: [], reduce: [],
    },
    data_gaps: ['PVC by LGA missing'],
  });
  const plan = checkAiPlan(`\`\`\`json\n${answer}\n\`\`\``, facts);
  assert.ok(plan);
  assert.deepEqual(plan.quadrants.do_now[0].evidence, ['G1'], 'unknown fact id dropped');
  assert.deepEqual(plan.quadrants.do_now[0].unverified, [], 'every figure is in the facts');
  assert.deepEqual(plan.quadrants.plan[0].unverified, ['55000'], 'an invented figure is flagged');
  assert.equal(plan.quadrants.plan[0].owner, 'Someone');
  assert.match(plan.quadrants.do_now[0].key, /^ai:[0-9a-f]{12}$/);
  assert.equal(checkAiPlan('not json', facts), null);
  assert.equal(checkAiPlan(JSON.stringify({ quadrants: { do_now: [{ title: 'One' }] } }), facts), null, 'too few actions');
});

test('askModels tries Gemini keys in turn and returns null when nothing answers', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('key=bad')) return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"quadrants":{}}' }] } }] }) };
  };
  const answer = await askModels('prompt', { geminiApiKeys: ['bad', 'good'], fetchImpl });
  assert.equal(answer.provider, 'gemini');
  assert.equal(calls.length, 2);
  const saved = { groq: process.env.GROQ_API_KEY, openai: process.env.OPENAI_API_KEY };
  delete process.env.GROQ_API_KEY; delete process.env.OPENAI_API_KEY;
  const errors = console.error; console.error = () => {};
  try { assert.equal(await askModels('prompt', { geminiApiKeys: [], fetchImpl }), null); } finally {
    console.error = errors;
    if (saved.groq) process.env.GROQ_API_KEY = saved.groq;
    if (saved.openai) process.env.OPENAI_API_KEY = saved.openai;
  }
});

test('plans and action statuses are stored and shared', async () => {
  const repo = createPreElectionRepository({ jsonDb: {}, saveJson: () => {} });
  await repo.savePreElectionPlan('state|week', { generatedAt: 'x' });
  assert.deepEqual(await repo.preElectionPlan('state|week'), { generatedAt: 'x' });
  assert.equal(await repo.preElectionPlan('state|fortnight'), null);
  await repo.setPreElectionActionStatus('rule:ground-empty', { status: 'doing' });
  await repo.setPreElectionActionStatus('rule:cc-backlog', { status: 'done' });
  assert.deepEqual(Object.keys(await repo.preElectionActionStatus()).sort(), ['rule:cc-backlog', 'rule:ground-empty']);
});
