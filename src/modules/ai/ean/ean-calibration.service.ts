import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import type { AiDecisionRecord, HumanDecisionRecord } from './ean-match.types';

export const CALIBRATION_KEY = 'ean_judge_calibration';
/** Limiares da spec: precisão ≥ 99,5% e limite inferior de Wilson (95%) ≥ 98%. */
export const MIN_PRECISION = 0.995;
export const MIN_WILSON_LOWER = 0.98;
const Z95 = 1.96;

export interface CalibrationResult {
  judgeVersion: string;
  /** Itens de calibração com decisão humana (não pulados). */
  rotulados: number;
  /** Quantos deles a IA teria aceitado sozinha (as "gravações" que medimos). */
  autoAceitos: number;
  corretos: number;
  precisao: number;
  wilsonInferior: number;
  /** Fração dos rotulados que a IA resolveria sem humano. */
  cobertura: number;
  aprovado: boolean;
  avaliadoEm: string;
}

/**
 * Calibração do auto-aceite (design §7). O auto-aceite só liga quando a
 * regra, medida contra decisões humanas às cegas, atinge os limiares — e só
 * para a MESMA identidade de juiz (modelos + prompt) que foi medida.
 */
@Injectable()
export class EanCalibrationService {
  private readonly logger = new Logger(EanCalibrationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SystemSettingsService,
  ) {}

  async autoAceiteLiberado(judgeVersion: string): Promise<boolean> {
    const r = await this.settings.get<CalibrationResult>(CALIBRATION_KEY);
    return Boolean(r && r.aprovado && r.judgeVersion === judgeVersion);
  }

  async estado(): Promise<CalibrationResult | null> {
    return this.settings.getFresh<CalibrationResult>(CALIBRATION_KEY);
  }

  /** Mede a regra contra todos os itens de calibração rotulados e grava o resultado. */
  async avaliar(judgeVersion: string): Promise<CalibrationResult> {
    const rows: Array<{ aiDecision: AiDecisionRecord | null; humanDecision: HumanDecisionRecord }> =
      await this.dataSource.query(
        `SELECT i."aiDecision", i."humanDecision"
           FROM ean_match_items i
           JOIN ean_match_jobs j ON j.id = i."jobId"
          WHERE i."isCalibration" = true
            AND i."humanDecision" IS NOT NULL
            AND i."humanDecision"->>'decision' <> 'skip'
            AND j."judgeVersion" = $1`,
        [judgeVersion],
      );
    const r = medir(rows, judgeVersion);
    await this.settings.set(CALIBRATION_KEY, r);
    this.logger.log(
      `Calibração ${judgeVersion}: ${r.corretos}/${r.autoAceitos} corretos, ` +
        `precisão ${(r.precisao * 100).toFixed(2)}%, Wilson ${(r.wilsonInferior * 100).toFixed(2)}% → ` +
        (r.aprovado ? 'APROVADO' : 'reprovado'),
    );
    return r;
  }
}

/**
 * Uma decisão automática é "correta" se o humano também disse que é o produto
 * e todas as imagens que a IA gravaria estão entre as que o humano escolheu.
 * A IA dizer "nenhuma" nunca grava nada, então não entra na precisão — só na
 * cobertura.
 */
export function medir(
  rows: Array<{ aiDecision: AiDecisionRecord | null; humanDecision: HumanDecisionRecord }>,
  judgeVersion: string,
): CalibrationResult {
  let autoAceitos = 0;
  let corretos = 0;
  let resolvidos = 0;
  for (const { aiDecision: ai, humanDecision: h } of rows) {
    if (!ai || !ai.autoAcceptEligible) continue;
    resolvidos += 1;
    if (ai.decision === 'none') continue;
    autoAceitos += 1;
    const humanas = new Set(h.imageIds);
    if (h.decision === 'match' && ai.imageIds.every((id) => humanas.has(id))) corretos += 1;
  }
  const precisao = autoAceitos === 0 ? 0 : corretos / autoAceitos;
  const wilsonInferior = wilsonLower(corretos, autoAceitos);
  return {
    judgeVersion,
    rotulados: rows.length,
    autoAceitos,
    corretos,
    precisao,
    wilsonInferior,
    cobertura: rows.length === 0 ? 0 : resolvidos / rows.length,
    aprovado: precisao >= MIN_PRECISION && wilsonInferior >= MIN_WILSON_LOWER,
    avaliadoEm: new Date().toISOString(),
  };
}

/** Limite inferior do intervalo de Wilson, 95%. */
export function wilsonLower(sucessos: number, n: number, z = Z95): number {
  if (n === 0) return 0;
  const p = sucessos / n;
  const z2 = z * z;
  const centro = p + z2 / (2 * n);
  const margem = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (centro - margem) / (1 + z2 / n);
}
