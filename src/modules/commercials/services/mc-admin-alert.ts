import { EntityManager } from 'typeorm';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { McErrorClass } from '../domain/mc-error-classes';
import { McEvent } from '../entities/mc-event.entity';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';

export interface McAdminAlertInput {
  manager: EntityManager;
  commercials: Pick<CommercialsService, 'appendEvent'>;
  transitions: Pick<TaskTransitionService, 'notify'>;
  project: Pick<McProject, 'id' | 'userId'>;
  step: Pick<McStep, 'id' | 'type' | 'provider'>;
  errorClass: McErrorClass;
  errorCode: string;
  message: string;
}

/**
 * `admin_alert` de falta de crédito/chave inválida do fornecedor, UM por projeto
 * (design Q3): o projeto é travado (`FOR UPDATE`) para que falas falhando em
 * paralelo se serializem e a segunda enxergue o alerta da primeira. Devolve a
 * linha de log `ADMIN_ALERT` quando gravou (o chamador loga DEPOIS do commit) ou
 * `null` quando o projeto já tinha alerta. O canal SSE do cliente não leva a causa.
 */
export async function recordAdminAlertOnce(input: McAdminAlertInput): Promise<string | null> {
  const { manager, project, step, errorClass, errorCode } = input;
  await manager.findOne(McProject, {
    where: { id: project.id },
    lock: { mode: 'pessimistic_write' },
  });
  const existing = await manager.count(McEvent, {
    where: { refKind: 'project', refId: project.id, kind: 'admin_alert' },
  });
  if (existing > 0) return null;
  const message = input.message.slice(0, 300);
  await input.commercials.appendEvent(manager, {
    userId: project.userId,
    refKind: 'project',
    refId: project.id,
    kind: 'admin_alert',
    detail: {
      errorClass,
      errorCode,
      stepId: step.id,
      stepType: step.type,
      provider: step.provider ?? null,
      message,
    },
  });
  await input.transitions.notify(
    manager,
    project.userId,
    { kind: 'mc_admin_alert', projectId: project.id },
    MC_EVENTS_CHANNEL,
  );
  return `ADMIN_ALERT ${errorClass} projeto=${project.id} step=${step.id} tipo=${step.type} provider=${step.provider ?? 'n/d'}: ${message}`;
}
