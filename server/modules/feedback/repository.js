import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Share links and the answers that come in through them. Postgres gets two small tables
 * (created on first use); the JSON store keeps two arrays.
 */
export function createFeedbackRepository({ pool, jsonDb, saveJson }) {
  let ready = null;
  const ensure = () => {
    if (!pool) return Promise.resolve();
    ready ||= pool.query(`
      create table if not exists feedback_links (
        id text primary key,
        token text unique not null,
        label text not null,
        lga text default '',
        active boolean default true,
        created_by text default '',
        created_at timestamptz default now()
      );
      create table if not exists feedback_responses (
        id text primary key,
        link_id text not null,
        submitted_at timestamptz default now(),
        lga text not null,
        ward integer,
        unit integer,
        answers jsonb not null
      );
      create index if not exists feedback_responses_link on feedback_responses (link_id);
      alter table feedback_responses add column if not exists facility jsonb;
      alter table feedback_responses add column if not exists collected_by text default '';
      create table if not exists feedback_projects (
        id text primary key,
        title text not null,
        lga text not null,
        ward integer,
        candidate text default '',
        active boolean default true,
        created_by text default '',
        created_at timestamptz default now()
      );
    `).catch((error) => { ready = null; throw error; });
    return ready;
  };
  const json = () => {
    jsonDb.feedbackLinks ||= [];
    jsonDb.feedbackResponses ||= [];
    jsonDb.feedbackProjects ||= [];
    return jsonDb;
  };
  const linkRow = (row) => ({ id: row.id, token: row.token, label: row.label, lga: row.lga || '', active: row.active !== false, createdBy: row.created_by ?? row.createdBy ?? '', createdAt: new Date(row.created_at ?? row.createdAt).toISOString() });
  const responseRow = (row) => ({ id: row.id, linkId: row.link_id ?? row.linkId, submittedAt: new Date(row.submitted_at ?? row.submittedAt).toISOString(), lga: row.lga, ward: row.ward ?? null, unit: row.unit ?? null, answers: row.answers || {}, facility: row.facility || null, collectedBy: row.collected_by ?? row.collectedBy ?? '' });
  const projectRow = (row) => ({ id: row.id, title: row.title, lga: row.lga, ward: row.ward ?? null, candidate: row.candidate || '', active: row.active !== false, createdAt: new Date(row.created_at ?? row.createdAt).toISOString() });

  return {
    async createFeedbackLink({ label, lga = '', createdBy = '' }) {
      const link = { id: randomUUID(), token: randomBytes(9).toString('base64url'), label, lga, active: true, createdBy, createdAt: new Date().toISOString() };
      if (!pool) { json().feedbackLinks.push(link); saveJson(); return link; }
      await ensure();
      await pool.query('insert into feedback_links (id, token, label, lga, active, created_by, created_at) values ($1,$2,$3,$4,true,$5,$6)', [link.id, link.token, label, lga, createdBy, link.createdAt]);
      return link;
    },
    async feedbackLinks() {
      if (!pool) return json().feedbackLinks.map(linkRow);
      await ensure();
      return (await pool.query('select * from feedback_links order by created_at desc')).rows.map(linkRow);
    },
    async feedbackLinkByToken(token) {
      if (!pool) { const found = json().feedbackLinks.find((link) => link.token === token); return found ? linkRow(found) : null; }
      await ensure();
      const row = (await pool.query('select * from feedback_links where token = $1', [token])).rows[0];
      return row ? linkRow(row) : null;
    },
    async setFeedbackLinkActive(id, active) {
      if (!pool) {
        const link = json().feedbackLinks.find((item) => item.id === id);
        if (!link) return null;
        link.active = Boolean(active); saveJson();
        return linkRow(link);
      }
      await ensure();
      const row = (await pool.query('update feedback_links set active = $2 where id = $1 returning *', [id, Boolean(active)])).rows[0];
      return row ? linkRow(row) : null;
    },
    async addFeedbackResponse({ linkId, lga, ward, unit, answers, facility = null, collectedBy = '' }) {
      const response = { id: randomUUID(), linkId, submittedAt: new Date().toISOString(), lga, ward, unit, answers, facility, collectedBy };
      if (!pool) { json().feedbackResponses.push(response); saveJson(); return response; }
      await ensure();
      await pool.query('insert into feedback_responses (id, link_id, submitted_at, lga, ward, unit, answers, facility, collected_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [response.id, linkId, response.submittedAt, lga, ward, unit, JSON.stringify(answers), facility ? JSON.stringify(facility) : null, collectedBy]);
      return response;
    },
    // Proposed projects voters rate (question 16), per LGA and optionally per ward.
    async createFeedbackProject({ title, lga, ward = null, candidate = '', createdBy = '' }) {
      const project = { id: randomUUID(), title, lga, ward, candidate, active: true, createdBy, createdAt: new Date().toISOString() };
      if (!pool) { json().feedbackProjects.push(project); saveJson(); return projectRow(project); }
      await ensure();
      await pool.query('insert into feedback_projects (id, title, lga, ward, candidate, active, created_by, created_at) values ($1,$2,$3,$4,$5,true,$6,$7)', [project.id, title, lga, ward, candidate, createdBy, project.createdAt]);
      return projectRow(project);
    },
    async feedbackProjects() {
      if (!pool) return json().feedbackProjects.map(projectRow);
      await ensure();
      return (await pool.query('select * from feedback_projects order by lga, ward nulls first, title')).rows.map(projectRow);
    },
    async setFeedbackProjectActive(id, active) {
      if (!pool) {
        const project = json().feedbackProjects.find((item) => item.id === id);
        if (!project) return null;
        project.active = Boolean(active); saveJson();
        return projectRow(project);
      }
      await ensure();
      const row = (await pool.query('update feedback_projects set active = $2 where id = $1 returning *', [id, Boolean(active)])).rows[0];
      return row ? projectRow(row) : null;
    },
    async feedbackResponses() {
      if (!pool) return json().feedbackResponses.map(responseRow);
      await ensure();
      return (await pool.query('select * from feedback_responses order by submitted_at')).rows.map(responseRow);
    },
  };
}
