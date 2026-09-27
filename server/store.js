import { createFieldOperationsRepository } from './modules/field-operations/repository.js';
import { createFoundationRepository } from './modules/foundation/repository.js';
import { createIdentityRepository } from './modules/identity/repository.js';
import { createIncidentsRepository } from './modules/incidents/repository.js';
import { createNotificationsRepository } from './modules/notifications/repository.js';
import { createGeographyRepository } from './modules/geography/repository.js';
import { createCommunicationsRepository } from './modules/communications/repository.js';
import { createIntelligenceRepository } from './modules/intelligence/repository.js';
import { createCrmSyncRepository } from './modules/intelligence/crm-sync-repository.js';
import { createDemographicsRepository } from './modules/intelligence/demographics-repository.js';
import { createConnectivityRepository } from './modules/intelligence/connectivity-repository.js';
import { createReportingRepository } from './modules/reporting/repository.js';
import { createReferenceDataRepository } from './modules/reference-data/repository.js';
import { createEvidenceRepository } from './modules/foundation/evidence-repository.js';
import { createResultsRepository } from './modules/results/repository.js';
import { createReconciliationRepository } from './modules/results/reconciliation-repository.js';
import { createTasksRepository } from './modules/tasks/repository.js';
import { createCameraRecordingsRepository } from './modules/field-operations/camera-recordings.js';
import { createVoterSurveyRepository } from './modules/voter-survey/repository.js';
import { createFeedbackRepository } from './modules/feedback/repository.js';
import { createPreElectionRepository } from './modules/pre-election/repository.js';

// Compatibility facade: modules own persistence; existing consumers keep their API.
export function createStore(context) {
  const repositories = {
    ...createFieldOperationsRepository(context),
    ...createFoundationRepository(context),
    ...createIdentityRepository(context),
    ...createIncidentsRepository(context),
    ...createNotificationsRepository(context),
    ...createGeographyRepository(context),
    ...createCommunicationsRepository(context),
    ...createIntelligenceRepository(context),
    ...createCrmSyncRepository(context),
    ...createDemographicsRepository(context),
    ...createConnectivityRepository(context),
    ...createReportingRepository(context),
    ...createReferenceDataRepository(context),
    ...createEvidenceRepository(context),
    ...createResultsRepository(context),
    ...createReconciliationRepository(context),
    ...createTasksRepository(context),
    ...createCameraRecordingsRepository(context),
    ...createVoterSurveyRepository(context),
    ...createFeedbackRepository(context),
    ...createPreElectionRepository(context),
  };
  if (context.transactionDisabled) return repositories;

  let jsonTransactionQueue = Promise.resolve();
  const withTransaction = async (callback) => {
    if (context.pool) {
      const client = await context.pool.connect();
      try {
        await client.query('begin');
        const transactionStore = createStore({ ...context, pool: client, transactionDisabled: true });
        const result = await callback(transactionStore);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    const run = jsonTransactionQueue.then(async () => {
      const snapshot = structuredClone(context.jsonDb);
      const transactionStore = createStore({ ...context, saveJson: () => {}, transactionDisabled: true });
      try {
        const result = await callback(transactionStore);
        context.saveJson();
        return result;
      } catch (error) {
        for (const key of Object.keys(context.jsonDb)) delete context.jsonDb[key];
        Object.assign(context.jsonDb, snapshot);
        throw error;
      }
    });
    jsonTransactionQueue = run.catch(() => {});
    return run;
  };

  return { ...repositories, withTransaction };
}
