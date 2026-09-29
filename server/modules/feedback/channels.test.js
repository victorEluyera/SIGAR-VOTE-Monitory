import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineSurvey, withBaseline } from '../pre-election/baseline.js';
import { onlineReport } from '../pre-election/overview.js';
import { buildFeedbackAnalysis } from './analysis.js';
import { buildChannels } from './channels.js';

test('feedback channels: call center, 10x field work and online, with critical intelligence from all three', () => {
  const survey = baselineSurvey();
  const centerSet = withBaseline([]).find((item) => item.kind === 'contact-center');
  const analysis = buildFeedbackAnalysis({ survey, centerSet });
  const channels = buildChannels({ survey, centerSet, online: onlineReport(), analysis });
  assert.equal(channels.callCenter.calls, centerSet.report.overview.calls);
  assert.ok(channels.callCenter.supporters.share > 0 && channels.callCenter.supporters.share <= 1);
  assert.equal(channels.field.responses, survey.rows.length);
  assert.equal(channels.field.label, '10x field work');
  assert.ok(channels.online.feedback.length >= 3);
  const sources = new Set(channels.critical.map((item) => item.source));
  for (const source of ['Call center', '10x field work', 'Online']) assert.ok(sources.has(source), `${source} feeds the critical intelligence`);
  const text = JSON.stringify({ callCenter: channels.callCenter, field: channels.field, critical: channels.critical });
  for (const rival of ['Hamzat', 'Adelabu', 'Ajadi']) assert.equal(text.includes(rival), false, `${rival} is not named`);
});

test('feedback channels: an LGA filter scopes the call center and the field work', () => {
  const survey = baselineSurvey();
  const centerSet = withBaseline([]).find((item) => item.kind === 'contact-center');
  const channels = buildChannels({ survey, centerSet, online: null, analysis: buildFeedbackAnalysis({ survey, centerSet, lga: 'Iseyin' }), lga: 'Iseyin' });
  assert.equal(channels.callCenter.scope, 'lga');
  assert.ok(channels.field.responses > 0 && channels.field.responses < survey.rows.length);
  assert.equal(channels.online.available, false);
});
