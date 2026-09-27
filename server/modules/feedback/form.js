import { wardResolver } from '../pre-election/geo.js';
import { matchLga, oyoLgas, lgaLabel } from '../pre-election/lga.js';

/**
 * The feedback form: the campaign's Core Field Questionnaire, answerable by anyone with a share
 * link (and by field agents, who are credited automatically when signed in). Two-part questions
 * are split into two, and every choice is a dropdown.
 *
 * Anonymous for the public: no name, phone, address or voter number is asked for, and anything
 * shaped like a phone number is removed from written answers. A facility can be geotagged, but
 * only when the person presses "use my location".
 */

export const FORM_VERSION = 2;
export const FOCUS_CANDIDATE = 'Sen. Sharafadeen Abiodun Alli';
// Governorship candidates listed for Oyo State.
export const CANDIDATES = [
  FOCUS_CANDIDATE,
  'Olooye Adegboyega Taofeek Adegoke',
  'Hazeem Gbolarumi',
  'Abimbola "Bimbo" Adekanmbi',
  'Yinusa Kazeem Ayandare',
  'Olasupo Olalekan Abdulsemiu',
  'Salami Gbolagade',
  'Aderoju Okunlade Michael',
  'Hassan Waheed Olanrewaju',
  'Olatunji Kunle James',
  'Kareem Thomson Sola',
  'Tijani Ismaila Akinbode',
  'Yusuf Akim Adebola',
  'Adebiyi Adedapo',
  'Afolabi Taofeek Adedamola',
  'Taiwo Ibiyemi Otegbeye',
];

export const SECTIONS = [
  { id: 'you', title: 'About you' },
  { id: 'area', title: 'Your area' },
  { id: 'issues', title: 'Issues' },
  { id: 'voting', title: 'Voting' },
  { id: 'information', title: 'Information' },
  { id: 'candidates', title: 'Candidates' },
  { id: 'projects', title: 'Projects in your ward' },
  { id: 'facility', title: 'Report a facility or problem spot' },
];

export const QUESTIONS = [
  { id: 'respondent', section: 'you', n: 1, text: 'Which category best describes you?', options: ['Youth Member', 'Market Sector', 'Civil Service', 'Transport Union', 'Youth Leader', 'Religious Leader', 'Labour Union', 'Traditional Leader', 'Other'], required: true },
  // 2: voting LGA (with optional ward and polling unit) is asked by the form itself.
  { id: 'topIssue', section: 'issues', n: 3, text: 'What is the single most important issue you want government to address?', options: ['Job Creation', 'Security', 'Agriculture', 'Education', 'Roads & Infrastructure', 'Youth Development', 'Healthcare', 'Power/Energy', 'Other'], required: true },
  { id: 'satisfaction', section: 'issues', n: 4, text: 'Overall, how satisfied are you with the performance of the current government?', options: ['Very Satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very Dissatisfied'], required: true },
  { id: 'sector', section: 'issues', n: 5, text: 'Which sector needs the most urgent improvement?', options: ['Education', 'Health', 'Economy', 'Agriculture', 'Security', 'Transportation', 'Infrastructure', 'Other'] },
  { id: 'fairAttention', section: 'area', n: '6a', text: 'Do you believe your community is receiving fair attention?', options: ['Yes', 'Partly', 'No', 'Not Sure'] },
  { id: 'lgaProblem', section: 'area', n: '6b', text: 'What is the biggest problem in your community?', options: ['Unemployment', 'Poor Roads', 'Insecurity', 'Business Support', 'Waste', 'Education', 'Healthcare', 'Other'] },
  { id: 'communicate', section: 'issues', n: 7, text: 'What would you most want political leaders and candidates to explain more clearly?', options: ['Plans & Policies', 'Achievements', 'Experience', 'Community Development', 'Jobs/Economy', 'Security', 'Infrastructure', 'Anti-Corruption', 'Other'] },
  { id: 'hasPvc', section: 'voting', n: '8a', text: 'Do you have a PVC?', options: ['Yes', 'No', 'Awaiting PVC'], required: true },
  { id: 'votedLast', section: 'voting', n: '8b', text: 'Did you vote in the last election?', options: ['Yes', 'No', 'Prefer Not to Say'] },
  { id: 'likelihood', section: 'voting', n: '9a', text: 'How likely are you to vote in the next election?', options: ['Very Likely', 'Likely', 'Not Sure', 'Unlikely'], required: true },
  { id: 'barrier', section: 'voting', n: '9b', text: 'What could prevent you from voting?', options: ['Nothing', 'Security', 'Transport', 'PVC Issue', 'Work', 'Health', 'Lack of Interest', 'Lack of Confidence', 'Other'] },
  { id: 'platform', section: 'information', n: 10, text: 'Where do you mainly get political and public-affairs information?', options: ['Radio', 'Television', 'WhatsApp', 'Facebook', 'Instagram', 'TikTok', 'X/Twitter', 'Community Meetings', 'Friends/Family', 'Other'] },
  { id: 'truthSource', section: 'information', n: 11, text: 'Which source do you trust most for reliable political information?', options: ['Community Leaders', 'Religious Leaders', 'Traditional Leaders', 'Verified Media', 'Family/Friends', 'Candidate Speeches', 'Social Media', 'Professionals', 'Other'] },
  { id: 'choice', section: 'candidates', n: 12, text: 'If the election were held today, which candidate are you currently considering?', options: [...CANDIDATES, 'Undecided', 'Other', 'Prefer Not to Say'] },
  { id: 'candidateFactor', section: 'candidates', n: 13, text: 'What is the single most important factor you consider when evaluating a candidate?', options: ['Competence & Experience', 'Integrity', 'Track Record', 'Development Record', 'Policies', 'Leadership Ability', 'Party', 'Community Connection', 'Youth-Friendly Policies', 'Other'] },
  { id: 'familiarity', section: 'candidates', n: '14a', text: `How familiar are you with ${FOCUS_CANDIDATE}?`, options: ['Very Familiar', 'Somewhat Familiar', 'Heard the Name', 'Not Familiar'] },
  { id: 'impression', section: 'candidates', n: '14b', text: `What is your overall impression of ${FOCUS_CANDIDATE}?`, options: ['Very Positive', 'Positive', 'Neutral', 'Negative', 'Very Negative'] },
  { id: 'goodGovernor', section: 'candidates', n: '15a', text: `Based on what you know, do you think ${FOCUS_CANDIDATE} would make a good governor?`, options: ['Yes', 'Maybe', 'No', "Don't Know Enough"] },
  { id: 'why', section: 'candidates', n: '15b', text: 'Why do you say so?', type: 'text', maxLength: 280 },
  { id: 'alternative', section: 'candidates', n: '15c', text: 'If not, who else are you considering?', options: [...CANDIDATES.slice(1), 'Undecided', 'None', 'Prefer Not to Say'] },
  { id: 'anyOtherComment', section: 'candidates', n: '16', text: 'Any other comment?', type: 'text', maxLength: 500 },
  // 16: project ratings (the ward's proposed projects, each 1-10) and 17: facility report are asked by the form itself.
];

export const FACILITY_TYPES = ['Road or bridge', 'Flooding or erosion point', 'Water or borehole', 'Electricity or street light', 'School', 'Health facility', 'Market', 'Security problem spot', 'Waste dump', 'Other'];
// Facility types -> the call center's need themes.
export const FACILITY_THEME = { 'Road or bridge': 'roads', 'Flooding or erosion point': 'roads', 'Water or borehole': 'water', 'Electricity or street light': 'electricity', School: 'education', 'Health facility': 'health', Market: 'jobs', 'Security problem spot': 'security', 'Waste dump': 'sanitation' };

// Answers -> the call center's need themes, so the field survey, the form and callers rank together.
// Keys are lowercased; both the field survey's wording and the form's are listed.
export const NEED_THEME_OF_ANSWER = {
  'job creation': 'jobs', unemployment: 'jobs', 'youth development': 'jobs', 'lack of business support': 'jobs', 'business support': 'jobs', economy: 'jobs', 'jobs/economy': 'jobs',
  security: 'security', insecurity: 'security',
  agriculture: 'agriculture',
  education: 'education', 'poor schooling conditions': 'education',
  'roads & infrastructure': 'roads', 'poor roads': 'roads', infrastructure: 'roads', transportation: 'roads',
  'health care': 'health', healthcare: 'health', health: 'health', 'health facility challenges': 'health',
  'power/energy': 'electricity', electricity: 'electricity',
  water: 'water',
  'waste management': 'sanitation', waste: 'sanitation',
};

/** What the public page needs to draw the form (projects arrive with the ward, see routes). */
export function formDefinition(link) {
  return {
    version: FORM_VERSION,
    title: 'Oyo State 10X Community Priorities Survey',
    intro: 'Have Your Say. Tell Us What Matters. We want to hear from you. This 5-minute anonymous survey by the Sen. Sharafadeen Alli campaign is designed to understand the needs, concerns and priorities of communities across Oyo State. No name. No phone number. No voter number. Just your honest feedback.',
    lga: link.lga ? { key: link.lga, name: lgaLabel(link.lga) } : null,
    lgas: oyoLgas().map((lga) => ({ key: lga.name, name: lgaLabel(lga.name) })),
    sections: SECTIONS,
    questions: QUESTIONS,
    facilityTypes: FACILITY_TYPES,
  };
}

const PHONE_LIKE = /\+?\d[\d\s-]{6,}\d/g;
export const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(PHONE_LIKE, '[number removed]').replace(/\s+/g, ' ').trim().slice(0, max);
// Oyo State's extent, with a margin: a facility pin outside it is dropped, not stored.
const OYO_BOUNDS = { minLat: 6.9, maxLat: 9.3, minLng: 2.5, maxLng: 4.8 };

/**
 * Checks a submission strictly: only known questions, only listed options, a real Oyo LGA and
 * (optionally) an INEC ward and polling unit in it, ratings 1-10 for projects offered in that
 * area, and a facility pin inside Oyo. Returns { value } or { error }.
 */
export function validateSubmission(body, link, { projects = [] } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const lga = matchLga(link.lga || input.lga);
  if (!lga) return { error: 'Choose the LGA where you are registered or expect to vote.' };
  let ward = null;
  let unit = null;
  if (input.ward !== undefined && input.ward !== null && input.ward !== '') {
    const place = wardResolver(lga)(String(input.ward));
    if (!place) return { error: 'That ward is not in the selected LGA.' };
    ward = place.number;
    if (input.unit !== undefined && input.unit !== null && input.unit !== '') {
      const found = place.units.find((item) => String(item.number) === String(Number(input.unit)));
      if (!found) return { error: 'That polling unit is not in the selected ward.' };
      unit = found.number;
    }
  }
  const answers = {};
  for (const question of QUESTIONS) {
    const value = input.answers?.[question.id];
    if (value === undefined || value === null || value === '') {
      if (question.required) return { error: `Please answer: ${question.text}` };
      continue;
    }
    if (question.type === 'text') {
      const text = cleanText(value, question.maxLength || 280);
      if (text) answers[question.id] = text;
      continue;
    }
    if (!question.options.includes(String(value))) return { error: `That is not one of the answers to: ${question.text}` };
    answers[question.id] = String(value);
  }

  // 16. Projects: only those offered for this LGA/ward, each rated 1-10.
  const offered = new Set(projects.filter((project) => project.active && project.lga === lga && (project.ward == null || project.ward === ward)).map((project) => project.id));
  const ratings = {};
  for (const [id, raw] of Object.entries(input.projects || {})) {
    if (raw === '' || raw === null || raw === undefined) continue;
    const score = Number(raw);
    if (!offered.has(id)) return { error: 'One of the projects is not offered for this area. Reload the page and try again.' };
    if (!Number.isInteger(score) || score < 1 || score > 10) return { error: 'Rate each project from 1 (not needed) to 10 (urgently needed).' };
    ratings[id] = score;
  }
  if (Object.keys(ratings).length) answers.projects = ratings;

  // 17. Facility or service needing attention.
  let facility = null;
  const f = input.facility || {};
  if (f.type) {
    if (!FACILITY_TYPES.includes(String(f.type))) return { error: 'Choose what kind of facility or problem it is.' };
    const lat = Number(f.lat);
    const lng = Number(f.lng);
    const pinned = Number.isFinite(lat) && Number.isFinite(lng) && lat >= OYO_BOUNDS.minLat && lat <= OYO_BOUNDS.maxLat && lng >= OYO_BOUNDS.minLng && lng <= OYO_BOUNDS.maxLng;
    facility = {
      type: String(f.type),
      note: cleanText(f.note, 200),
      ...(pinned ? { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)), accuracy: Number.isFinite(Number(f.accuracy)) ? Math.round(Number(f.accuracy)) : null } : {}),
    };
  }
  return { value: { lga, ward, unit, answers, facility } };
}
