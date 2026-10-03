// Whitelist aggregate fields; never pass through original free text or respondent records.
const rows = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const nullableText = (value) => value == null ? null : text(value);
const count = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
export const nullableCount = (value) => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Number(value);
const sentiment = (value) => Object.fromEntries(['positive', 'negative', 'neutral', 'other'].map((key) => [key, count(value?.[key])]));
const topics = (value) => rows(value).map((row) => ({ topic: text(row?.topic), responses: count(row?.responses) }));
const questions = (value) => rows(value).map((row) => ({
  task_id: text(row?.task_id), task_title: text(row?.task_title), question_id: text(row?.question_id),
  question: text(row?.question), type: text(row?.type), responses: count(row?.responses),
  answers: row?.type === 'text' || row?.type === 'textarea' || row?.type === 'free_text' ? [] : rows(row?.answers).map((answer) => ({ value: text(answer?.value), responses: count(answer?.responses) })),
  free_text_responses: count(row?.free_text_responses), unclassified_responses: count(row?.unclassified_responses),
}));

export function sanitizeFieldWork(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    surveys: count(raw.surveys), responses: count(raw.responses),
    first_collected_at: nullableText(raw.first_collected_at), last_collected_at: nullableText(raw.last_collected_at),
    reporting_timezone: text(raw.reporting_timezone) || 'Africa/Lagos',
    responses_by_date: rows(raw.responses_by_date).map((row) => ({ date: text(row?.date), responses: count(row?.responses) })),
    questions: questions(raw.questions), issues_and_needs: topics(raw.issues_and_needs),
    sentiment: sentiment(raw.sentiment), sentiment_available: raw.sentiment_available === true,
    invalid_answer_payload_responses: count(raw.invalid_answer_payload_responses),
    methods: Object.fromEntries(['answers', 'sentiment', 'issues_and_needs', 'free_text'].map((key) => [key, text(raw.methods?.[key])])),
    by_location: rows(raw.by_location).map((row) => ({
      lga: text(row?.lga), ward: text(row?.ward), ward_code: nullableText(row?.ward_code),
      polling_unit: text(row?.polling_unit), polling_unit_code: nullableText(row?.polling_unit_code),
      location_resolved: row?.location_resolved === true, responses: count(row?.responses),
      first_collected_at: nullableText(row?.first_collected_at), last_collected_at: nullableText(row?.last_collected_at),
      questions: questions(row?.questions), issues_and_needs: topics(row?.issues_and_needs), sentiment: sentiment(row?.sentiment),
    })),
  };
}

export function sanitizeOverlap(raw, total) {
  const loaded = raw?.loaded === true;
  return {
    loaded, matchedPromoters: loaded ? nullableCount(raw?.matched_promoters ?? total) : null,
    matchedPromoterRecords: loaded ? nullableCount(raw?.matched_promoter_records) : null,
    promoterRecords: loaded ? nullableCount(raw?.promoter_records) : null,
    matchablePromoterRecords: loaded ? nullableCount(raw?.matchable_promoter_records) : null,
    sourceRecords: loaded ? nullableCount(raw?.source_records) : null,
    sourceIdentities: loaded ? nullableCount(raw?.source_identities) : null,
    sourceLoadedAt: loaded ? nullableText(raw?.source_loaded_at) : null,
    method: text(raw?.method), membershipBasis: text(raw?.membership_basis),
  };
}
