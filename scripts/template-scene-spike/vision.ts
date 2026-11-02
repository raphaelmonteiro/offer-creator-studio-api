import * as fs from 'fs';
import { paidVision } from './calls';
import type { Services } from './calls';
import type { EditResult } from './edit-cases';
import { VISION_PROMPT } from './prompts';

export interface VisionResult {
  key: string;
  forKey: string;
  model: string;
  request: string;
  parseOk: boolean;
  mudou?: string;
  atendeu?: 'sim' | 'parcial' | 'nao';
  fez_algo?: boolean;
  text: string;
  costUsd: number;
  requestId: string | null;
  latencyMs: number;
  dryRun: boolean;
}

/** Interpreta a resposta JSON da visão (PV-4); fora do esquema, `parseOk` fica falso e o texto é guardado. */
export function parseVision(
  text: string,
): Pick<VisionResult, 'parseOk' | 'mudou' | 'atendeu' | 'fez_algo'> {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const ok =
      typeof json.mudou === 'string' &&
      ['sim', 'parcial', 'nao'].includes(json.atendeu as string) &&
      typeof json.fez_algo === 'boolean';
    if (!ok) return { parseOk: false };
    return {
      parseOk: true,
      mudou: json.mudou as string,
      atendeu: json.atendeu as 'sim' | 'parcial' | 'nao',
      fez_algo: json.fez_algo as boolean,
    };
  } catch {
    return { parseOk: false };
  }
}

/** Bloco E: visão antes/depois (recortes `detail: low`) de uma edição já concluída. */
export async function runVisionFor(svc: Services, edit: EditResult): Promise<VisionResult> {
  const key = `E:${edit.key}`;
  const r = await paidVision(svc, {
    caseId: key,
    block: 'E',
    step: 'vision',
    prompt: VISION_PROMPT(edit.request),
    before: fs.readFileSync(edit.files.before),
    after: fs.readFileSync(edit.files.final),
  });
  return {
    key,
    forKey: edit.key,
    model: svc.config.visionModel,
    request: edit.request,
    ...parseVision(r.value.text),
    text: r.value.text.slice(0, 600),
    costUsd: r.costUsd,
    requestId: r.requestId,
    latencyMs: r.latencyMs,
    dryRun: svc.session.dryRun,
  };
}
