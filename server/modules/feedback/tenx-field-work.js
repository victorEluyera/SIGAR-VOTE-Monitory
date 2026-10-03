import { matchLga, lgaLabel } from '../pre-election/lga.js';

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
const share = (value, total) => total ? value / total : null;
const mergeTopics = (locations) => {
  const topics = new Map();
  for (const row of locations) for (const topic of row.issues_and_needs) topics.set(topic.topic, (topics.get(topic.topic) || 0) + topic.responses);
  return [...topics].map(([topic, responses]) => ({ topic, responses }));
};
const mergeQuestions = (locations) => {
  const merged = new Map();
  for (const row of locations) for (const question of row.questions) {
    const key = JSON.stringify([question.task_id, question.question_id]);
    if (!merged.has(key)) merged.set(key, { ...question, responses: 0, free_text_responses: 0, unclassified_responses: 0, answers: new Map() });
    const target = merged.get(key);
    for (const key of ['responses', 'free_text_responses', 'unclassified_responses']) target[key] += question[key];
    for (const answer of question.answers) target.answers.set(answer.value, (target.answers.get(answer.value) || 0) + answer.responses);
  }
  return [...merged.values()].map((question) => ({ ...question, answers: [...question.answers].map(([value, responses]) => ({ value, responses })) }));
};

export function tenxFieldChannel(work, wanted) {
  const locations = work.by_location.filter((row) => !wanted || matchLga(row.lga) === wanted);
  const responses = wanted ? sum(locations, 'responses') : work.responses;
  const sentiment = wanted ? Object.fromEntries(['positive', 'negative', 'neutral', 'other'].map((key) => [key, locations.reduce((total, row) => total + row.sentiment[key], 0)])) : work.sentiment;
  const classified = sentiment.positive + sentiment.negative + sentiment.neutral;
  const topics = wanted ? mergeTopics(locations) : work.issues_and_needs;
  const byLga = new Map();
  for (const row of locations) {
    const lga = matchLga(row.lga);
    const name = lga ? lgaLabel(lga) : row.lga || 'Unresolved location';
    byLga.set(name, (byLga.get(name) || 0) + row.responses);
  }
  const first = wanted ? locations.map((row) => row.first_collected_at).filter(Boolean).sort()[0] || null : work.first_collected_at;
  const last = wanted ? locations.map((row) => row.last_collected_at).filter(Boolean).sort().at(-1) || null : work.last_collected_at;
  return {
    available: true, source: 'oyo10x', label: '10x field work', responses,
    sentimentAvailable: work.sentiment_available && classified > 0,
    sentiment: { ...sentiment, classified, positiveShare: work.sentiment_available ? share(sentiment.positive, classified) : null, negativeShare: work.sentiment_available ? share(sentiment.negative, classified) : null },
    surveys: wanted ? new Set(locations.flatMap((row) => row.questions.map((question) => question.task_id))).size : work.surveys,
    firstCollectedAt: first, lastCollectedAt: last, reportingTimezone: work.reporting_timezone,
    perDay: wanted ? [] : work.responses_by_date,
    invalidAnswers: wanted ? null : work.invalid_answer_payload_responses,
    methods: work.methods,
    topIssues: topics.map((row) => ({ name: row.topic, count: row.responses, share: share(row.responses, responses) })).sort((a, b) => b.count - a.count),
    detail: { questions: wanted ? mergeQuestions(locations) : work.questions, locations,
      byLga: [...byLga].map(([name, answers]) => ({ name, answers })).sort((a, b) => b.answers - a.answers),
      weakest: [], strongest: [], thin: [], lgaProblem: [], satisfaction: [], platform: [], barrier: [], candidateFactor: [],
    },
  };
}
