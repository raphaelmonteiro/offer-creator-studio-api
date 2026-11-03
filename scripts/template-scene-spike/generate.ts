import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import { paidGenerate } from './calls';
import type { Services } from './calls';
import { formatOrThrow, nativeSize } from './formats';
import type { FormatSpec } from './formats';
import { StopError } from './budget';
import { say } from './runner';
import type { CasesFile, SceneCase } from './types';

export interface SceneResult {
  sceneId: string;
  formatId: string;
  prompt: string;
  expected: { width: number; height: number };
  actual: { width: number; height: number };
  sizeMismatch: boolean;
  file: string;
  costUsd: number;
  latencyMs: number;
  requestId: string | null;
  usage?: unknown;
  dryRun: boolean;
}

const RULES =
  'Sem texto legível, sem logotipos, sem preços, sem marcas, sem pessoas reais. Ilustração fotográfica de alta qualidade.';

const pct = (cm: number, total: number): number => Math.round((cm / total) * 100);

/** Prompt em português: pedido da cena, regras fixas e as zonas reservadas do formato. */
export function buildScenePrompt(scene: SceneCase, format: FormatSpec): string {
  const orientation = format.artWidthCm > format.artHeightCm ? 'paisagem' : 'retrato';
  const header = pct(format.headerCm, format.artHeightCm);
  const footer = pct(format.footerCm, format.artHeightCm);
  return [
    `${scene.prompt}.`,
    `Fundo para um encarte de supermercado impresso em ${orientation} (${format.id}, arte de ${format.artWidthCm} x ${format.artHeightCm} cm).`,
    `Composição: reserve o topo (cerca de ${header}% da altura) como cabeçalho e a base (cerca de ${footer}% da altura) como rodapé, ambos com fundo calmo e contínuo, sem elementos importantes; o corpo central será coberto por cards de produto, então mantenha o fundo ali harmonioso e sem detalhes que disputem atenção.`,
    RULES,
  ].join(' ');
}

function writeScene(dir: string, id: string, png: Buffer): string {
  const file = path.join(dir, 'scenes', `${id}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  return file;
}

async function generateScene(svc: Services, scene: SceneCase): Promise<void> {
  const { session } = svc;
  const format = formatOrThrow(scene.formatId);
  const size = nativeSize(format.artWidthCm, format.artHeightCm);
  const prompt = buildScenePrompt(scene, format);
  const sizeText = `${size.width}x${size.height}`;
  const result = await paidGenerate(svc, {
    caseId: scene.id,
    block: 'F1',
    step: 'generate',
    prompt,
    size: sizeText,
  });
  const meta = await sharp(result.value.png).metadata();
  const actual = { width: meta.width ?? 0, height: meta.height ?? 0 };
  const file = writeScene(session.dir, scene.id, result.value.png);
  const out: SceneResult = {
    sceneId: scene.id,
    formatId: scene.formatId,
    prompt,
    expected: size,
    actual,
    sizeMismatch: actual.width !== size.width || actual.height !== size.height,
    file,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    requestId: result.requestId,
    usage: result.value.usage,
    dryRun: session.dryRun,
  };
  session.state.writeResult(`scene-${scene.id}`, out);
  session.state.set(scene.id, 'done', out.sizeMismatch ? 'size_mismatch' : undefined);
  say(
    `  ${scene.id} ${sizeText} ok  US$ ${result.costUsd.toFixed(4)}  ${result.latencyMs} ms${out.sizeMismatch ? `  ATENÇÃO: veio ${actual.width}x${actual.height}` : ''}`,
  );
}

/** Fase 1: gera as cenas em PNG no tamanho nativo; pula as `done` e refaz com `--only`. */
export async function runGenerate(svc: Services, cases: CasesFile, only?: string): Promise<void> {
  const { session } = svc;
  for (const scene of cases.scenes) {
    if (only && scene.id !== only) continue;
    if (!only && session.state.statusOf(scene.id) === 'done') {
      say(`  ${scene.id} já concluída: pulada (use --only ${scene.id} para refazer)`);
      continue;
    }
    try {
      await generateScene(svc, scene);
    } catch (err) {
      if (err instanceof StopError) throw err;
      session.state.set(scene.id, 'failed', (err as Error).message.slice(0, 200));
      say(`  ${scene.id} falhou: ${(err as Error).message}`);
    }
  }
  const done = cases.scenes.filter((s) => session.state.statusOf(s.id) === 'done').length;
  say(`Fase 1: ${done} de ${cases.scenes.length} cenas concluídas.`);
}
