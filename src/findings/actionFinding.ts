import { filesRepo } from '../db/repositories/files';
import { findingsRepo, type FindingAction, type FindingRecord } from '../db/repositories/findings';
import { chunksRepo } from '../db/repositories/chunks';
import { summariesRepo } from '../db/repositories/summaries';
import { AppError } from '../utils/appErrors';

export interface ActionFindingResult {
  applied: number;
}

export async function actionFinding(
  finding: Pick<FindingRecord, 'id' | 'projectId' | 'actions'>
): Promise<ActionFindingResult> {
  let applied = 0;

  for (const action of finding.actions) {
    await applyFindingAction(finding.projectId, action);
    applied += 1;
  }

  return { applied };
}

export async function implementFinding(findingId: string): Promise<FindingRecord | undefined> {
  const finding = await findingsRepo.findById(findingId);
  if (!finding) return undefined;

  if (finding.actions.length > 0 && !finding.actionsAppliedAt) {
    await actionFinding(finding);
  }

  return findingsRepo.updateStatus(findingId, 'implemented', {
    reviewedAt: new Date(),
    actionsAppliedAt: finding.actions.length > 0 && !finding.actionsAppliedAt
      ? new Date()
      : finding.actionsAppliedAt ?? null,
  });
}

async function applyFindingAction(projectId: string, action: FindingAction): Promise<void> {
  switch (action.targetType) {
    case 'chunk':
      await applyChunkAction(projectId, action);
      return;
    case 'summary':
      await applySummaryAction(projectId, action);
      return;
    case 'file':
      await applyFileAction(projectId, action);
      return;
    case 'finding':
      await applyFindingStatusAction(projectId, action);
      return;
  }
}

async function applyChunkAction(projectId: string, action: FindingAction): Promise<void> {
  const chunk = await chunksRepo.findById(action.targetId);
  if (!chunk || chunk.projectId !== projectId) {
    throw actionTargetError(action);
  }

  if (action.action === 'delete') {
    await chunksRepo.softDelete(action.targetId);
    return;
  }

  await chunksRepo.updateFact(action.targetId, requireUpdateText(action));
}

async function applySummaryAction(projectId: string, action: FindingAction): Promise<void> {
  const summary = await summariesRepo.findById(action.targetId);
  if (!summary || summary.projectId !== projectId) {
    throw actionTargetError(action);
  }

  if (action.action === 'delete') {
    await summariesRepo.softDelete(action.targetId);
    return;
  }

  await summariesRepo.update(action.targetId, { content: requireUpdateText(action) });
}

async function applyFileAction(projectId: string, action: FindingAction): Promise<void> {
  const file = await filesRepo.findByIdForProject(projectId, action.targetId);
  if (!file) {
    throw actionTargetError(action);
  }

  if (action.action === 'delete') {
    await filesRepo.softDeleteById(action.targetId);
    return;
  }

  await filesRepo.update(action.targetId, { purpose: requireUpdateText(action) });
}

async function applyFindingStatusAction(projectId: string, action: FindingAction): Promise<void> {
  if (action.action !== 'done') {
    throw new AppError('Finding target only supports done actions', {
      statusCode: 400,
      code: 'finding_action_invalid',
      publicMessage: 'Finding action is invalid',
      details: {
        targetType: action.targetType,
        targetId: action.targetId,
        action: action.action,
      },
    });
  }

  const finding = await findingsRepo.findById(action.targetId);
  if (!finding || finding.projectId !== projectId) {
    throw actionTargetError(action);
  }

  await findingsRepo.updateStatus(action.targetId, 'implemented', {
    reviewedAt: new Date(),
  });
}

function requireUpdateText(action: FindingAction): string {
  const updateText = action.updateText?.trim();
  if (!updateText) {
    throw new AppError('Finding update action is missing updateText', {
      statusCode: 400,
      code: 'finding_action_invalid',
      publicMessage: 'Finding action is missing update text',
      details: {
        targetType: action.targetType,
        targetId: action.targetId,
      },
    });
  }

  return updateText;
}

function actionTargetError(action: FindingAction): AppError {
  return new AppError('Finding action target not found', {
    statusCode: 400,
    code: 'finding_action_target_not_found',
    publicMessage: 'Finding action target not found',
    details: {
      targetType: action.targetType,
      targetId: action.targetId,
      action: action.action,
    },
  });
}