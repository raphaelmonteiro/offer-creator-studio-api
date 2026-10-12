import { HttpException, HttpStatus } from '@nestjs/common';
import { McLogoBox, McScript } from './mc-types';

/**
 * Caixa do logo do modo "rosto do logo" (change video-formatos-personagem,
 * D9b / tarefa 4.6; specs video-talking-art "Modo rosto do logo" e
 * video-project-from-art "Caixa do logo"): parte PURA — resolução em camadas,
 * validação da marcação, parse da resposta do modelo de visão, IoU e a
 * prontidão para produzir. O IO (Gemini) fica em
 * services/mc-logo-locator.service.ts; a persistência, em McFromArtService.
 *
 * Camadas: (a) caixa enviada pela ponte (o layout tem elemento de logo) →
 * `layout`, confirmada; (b) senão, detecção por visão com o logo do kit como
 * referência; (c) confiança ≥ 0,7 → `detected`, PROPOSTA (o usuário
 * confirma); abaixo disso → `none`, o usuário marca a caixa na prévia.
 *
 * Coordenadas: frações 0..1 da largura/altura da ARTE (McLogoBox), origem no
 * canto superior esquerdo — "dentro da arte" é dentro de [0,1]².
 */

/** Confiança mínima para propor a caixa detectada (abaixo disso o usuário marca). */
export const MC_LOGO_BOX_MIN_CONFIDENCE = 0.7;
/** Lado mínimo da caixa marcada, em fração da arte (2% ≈ 22 px numa arte de 1080). */
export const MC_LOGO_BOX_MIN_SIDE = 0.02;
/** Folga de arredondamento ao checar se a caixa cabe na arte (x + w ≤ 1). */
const BOUNDS_EPSILON = 1e-4;
/** Diferença máxima por coordenada para "confirmar a proposta" em vez de "marcar outra". */
const SAME_BOX_TOLERANCE = 0.005;

export const MC_LOGO_BOX_SOURCES = ['layout', 'detected', 'user', 'none'] as const;
export type McLogoBoxSource = (typeof MC_LOGO_BOX_SOURCES)[number];

/** Ações que a UI oferece a partir do estado da caixa (e o `details.actions` do 422). */
export type McLogoBoxAction =
  | 'confirm_logo_box'
  | 'mark_logo_box'
  | 'detect_logo_box'
  | 'use_window';

/**
 * Forma persistida em `mc_projects.logoBox` (jsonb): a caixa + origem,
 * confiança da detecção e confirmação, DENTRO do mesmo objeto (sem colunas
 * novas). `none` nunca é persistido: sem caixa a coluna fica NULL (quem lê
 * `!!project.logoBox` continua significando "há uma caixa utilizável").
 */
export interface McProjectLogoBox extends McLogoBox {
  logoBoxSource: Exclude<McLogoBoxSource, 'none'>;
  /** Confiança da detecção (0..1); null para caixa do layout ou marcada pelo usuário. */
  logoBoxConfidence: number | null;
  /** Só caixa confirmada libera a produção no modo rosto do logo. */
  logoBoxConfirmed: boolean;
}

/** Resultado do detector (services/mc-logo-locator.service.ts). Nunca lança: falha vira `error`. */
export interface McLogoLocatorResult {
  found: boolean;
  /** Caixa devolvida pelo modelo (mesmo abaixo de 0,7 — serve de dica para a marcação). */
  bbox: McLogoBox | null;
  /** 0..1 — quão certo o modelo está de que `bbox` contém o logo do kit. */
  confidence: number;
  model: string;
  at: string;
  /** Resultado sintético (MC_KIT_PROVIDER=mock) — nunca gastou visão. */
  mock?: boolean;
  /** Visão indisponível/ilegível: tratado como "não localizado" (o usuário marca). */
  error?: string;
}

/** Decisão das camadas (a)→(c): o que gravar e o que a UI deve oferecer. */
export interface McLogoBoxResolution {
  source: McLogoBoxSource;
  /** O que persistir (null quando `none`). */
  logoBox: McProjectLogoBox | null;
  confidence: number | null;
  confirmed: boolean;
  actions: McLogoBoxAction[];
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Quatro números finitos com área positiva, recortados a [0,1]² (o modelo às vezes passa da borda). */
export function clampLogoBox(value: unknown): McLogoBox | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const x0 = finite(raw.x);
  const y0 = finite(raw.y);
  const w0 = finite(raw.w);
  const h0 = finite(raw.h);
  if (x0 == null || y0 == null || w0 == null || h0 == null || w0 <= 0 || h0 <= 0) return null;
  const left = Math.min(1, Math.max(0, x0));
  const top = Math.min(1, Math.max(0, y0));
  const right = Math.min(1, Math.max(0, x0 + w0));
  const bottom = Math.min(1, Math.max(0, y0 + h0));
  if (right - left <= 0 || bottom - top <= 0) return null;
  return {
    x: round4(left),
    y: round4(top),
    w: round4(right - left),
    h: round4(bottom - top),
  };
}

/**
 * Lê `mc_projects.logoBox` na forma nova. Caixa SEM os campos de origem
 * (projetos anteriores à 4.6, ou `createProject` direto com `logoBox`) veio
 * do layout pela ponte → `layout`, confirmada. Coordenadas inválidas → null.
 */
export function readProjectLogoBox(raw: unknown): McProjectLogoBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const box = clampLogoBox(raw);
  if (!box) return null;
  const meta = raw as Partial<McProjectLogoBox>;
  const source =
    meta.logoBoxSource === 'detected' || meta.logoBoxSource === 'user'
      ? meta.logoBoxSource
      : 'layout';
  const confidence = finite(meta.logoBoxConfidence);
  return {
    ...box,
    logoBoxSource: source,
    logoBoxConfidence: confidence == null ? null : Math.min(1, Math.max(0, confidence)),
    logoBoxConfirmed:
      typeof meta.logoBoxConfirmed === 'boolean' ? meta.logoBoxConfirmed : source !== 'detected',
  };
}

/** Ações da UI para uma caixa gravada: nada a fazer, confirmar a proposta, ou marcar. */
export function logoBoxActions(box: McProjectLogoBox | null): McLogoBoxAction[] {
  if (!box) return ['mark_logo_box', 'use_window'];
  if (!box.logoBoxConfirmed) return ['confirm_logo_box', 'mark_logo_box'];
  return [];
}

/**
 * Camadas (a)→(c). `layoutBox` (enviada pela ponte) vence sem detecção;
 * senão a detecção com confiança ≥ 0,7 vira proposta não confirmada; o resto
 * (não achou, confiança baixa, caixa inválida, visão fora) é `none`.
 */
export function resolveLogoBox(input: {
  layoutBox?: McLogoBox | null;
  detection?: McLogoLocatorResult | null;
}): McLogoBoxResolution {
  const layout = input.layoutBox ? clampLogoBox(input.layoutBox) : null;
  if (layout) {
    const logoBox: McProjectLogoBox = {
      ...layout,
      logoBoxSource: 'layout',
      logoBoxConfidence: null,
      logoBoxConfirmed: true,
    };
    return { source: 'layout', logoBox, confidence: null, confirmed: true, actions: [] };
  }
  const detection = input.detection ?? null;
  const bbox = detection?.bbox ? clampLogoBox(detection.bbox) : null;
  const confidence = detection ? Math.min(1, Math.max(0, finite(detection.confidence) ?? 0)) : null;
  if (
    detection &&
    !detection.error &&
    detection.found &&
    bbox &&
    confidence != null &&
    confidence >= MC_LOGO_BOX_MIN_CONFIDENCE
  ) {
    const logoBox: McProjectLogoBox = {
      ...bbox,
      logoBoxSource: 'detected',
      logoBoxConfidence: round4(confidence),
      logoBoxConfirmed: false,
    };
    return {
      source: 'detected',
      logoBox,
      confidence: logoBox.logoBoxConfidence,
      confirmed: false,
      actions: logoBoxActions(logoBox),
    };
  }
  return {
    source: 'none',
    logoBox: null,
    confidence,
    confirmed: false,
    actions: logoBoxActions(null),
  };
}

/** Problema de validação de uma caixa marcada (422 com código — regra de negócio, D13). */
export interface McLogoBoxIssue {
  code: 'LOGO_BOX_INVALID' | 'LOGO_BOX_OUT_OF_BOUNDS' | 'LOGO_BOX_TOO_SMALL';
  message: string;
  details: Record<string, unknown>;
}

/**
 * Marcação do usuário (PUT): frações finitas em 0..1 (o DTO já barra com 400;
 * aqui é a defesa de quem chama o service direto), caixa INTEIRA dentro da
 * arte (x + w ≤ 1, y + h ≤ 1) e lado mínimo de 2% da arte.
 */
export function validateLogoBoxInArt(box: McLogoBox): McLogoBoxIssue | null {
  const values = [box?.x, box?.y, box?.w, box?.h];
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
    return {
      code: 'LOGO_BOX_INVALID',
      message: 'A caixa do logo precisa de x, y, w e h entre 0 e 1 (frações da arte).',
      details: { logoBox: box ?? null },
    };
  }
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  if (right > 1 + BOUNDS_EPSILON || bottom > 1 + BOUNDS_EPSILON) {
    return {
      code: 'LOGO_BOX_OUT_OF_BOUNDS',
      message: 'A caixa do logo precisa ficar inteira dentro da arte.',
      details: {
        logoBox: { x: box.x, y: box.y, w: box.w, h: box.h },
        right: round4(right),
        bottom: round4(bottom),
      },
    };
  }
  if (box.w < MC_LOGO_BOX_MIN_SIDE || box.h < MC_LOGO_BOX_MIN_SIDE) {
    return {
      code: 'LOGO_BOX_TOO_SMALL',
      message: `A caixa do logo precisa ter pelo menos ${MC_LOGO_BOX_MIN_SIDE * 100}% da arte em cada lado.`,
      details: {
        logoBox: { x: box.x, y: box.y, w: box.w, h: box.h },
        minSide: MC_LOGO_BOX_MIN_SIDE,
      },
    };
  }
  return null;
}

function sameBox(a: McLogoBox, b: McLogoBox): boolean {
  return (
    Math.abs(a.x - b.x) <= SAME_BOX_TOLERANCE &&
    Math.abs(a.y - b.y) <= SAME_BOX_TOLERANCE &&
    Math.abs(a.w - b.w) <= SAME_BOX_TOLERANCE &&
    Math.abs(a.h - b.h) <= SAME_BOX_TOLERANCE
  );
}

/**
 * Caixa que o usuário marcou/confirmou (já validada). Repetir a proposta
 * (mesma caixa, ±0,5%) CONFIRMA a detecção — origem e confiança ficam; uma
 * caixa diferente é marcação do usuário. Sempre confirmada.
 */
export function confirmLogoBox(current: McProjectLogoBox | null, box: McLogoBox): McProjectLogoBox {
  const marked = { x: round4(box.x), y: round4(box.y), w: round4(box.w), h: round4(box.h) };
  if (current && current.logoBoxSource !== 'user' && sameBox(current, marked)) {
    return { ...current, logoBoxConfirmed: true };
  }
  return { ...marked, logoBoxSource: 'user', logoBoxConfidence: null, logoBoxConfirmed: true };
}

/** Intersecção sobre união de duas caixas normalizadas (0 quando não se tocam). */
export function logoBoxIoU(a: McLogoBox, b: McLogoBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// ─────────────────────────── visão (prompt + parse) ───────────────────────────

/**
 * Prompt do localizador: imagem 1 = arte, imagem 2 = logo do kit. Pede a
 * caixa no formato nativo de detecção do Gemini (`box_2d` = [ymin, xmin,
 * ymax, xmax] em 0–1000), que localiza melhor que frações livres.
 */
export const MC_LOGO_LOCATOR_PROMPT = [
  'You are locating a brand logo inside a retail promotional image.',
  'IMAGE 1 is the promotional art (supermarket flyer or social media post).',
  'IMAGE 2 is the brand logo. Find where the logo from IMAGE 2 appears in IMAGE 1',
  '(it may be scaled, slightly recolored or placed on a colored panel).',
  'Answer ONLY with compact JSON: {"found": true|false, "confidence": 0.0-1.0,',
  '"box_2d": [ymin, xmin, ymax, xmax] | null}.',
  '"box_2d": the tight bounding box of the logo in IMAGE 1, integers normalized to 0-1000',
  'with the origin at the top-left corner; null when the logo is not in IMAGE 1.',
  'If the logo appears more than once, return the largest occurrence.',
  '"confidence": how sure you are that box_2d contains this same logo (0 when not found).',
  'Do not return prices, product photos or text that merely resemble the logo.',
].join(' ');

/** `box_2d` [ymin, xmin, ymax, xmax] (0–1000; ou 0–1 quando o modelo já normalizou) → caixa. */
function fromBox2d(value: unknown): McLogoBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map(finite);
  if (nums.some((n) => n == null)) return null;
  const scale = nums.every((n) => (n as number) <= 1) ? 1 : 1000;
  const [ymin, xmin, ymax, xmax] = nums.map((n) => (n as number) / scale);
  return clampLogoBox({
    x: Math.min(xmin, xmax),
    y: Math.min(ymin, ymax),
    w: Math.abs(xmax - xmin),
    h: Math.abs(ymax - ymin),
  });
}

/**
 * Parse tolerante (o modelo às vezes cerca com ```json): primeiro objeto
 * JSON do texto; aceita `box_2d` (pedido) ou `bbox` {x,y,w,h} em frações.
 * Sem `found` booleano → null (quem chama trata como "não localizado").
 */
export function parseLogoLocatorResponse(
  text: string,
): Pick<McLogoLocatorResult, 'found' | 'bbox' | 'confidence'> | null {
  const match = (text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.found !== 'boolean') return null;
    const bbox = fromBox2d(parsed.box_2d) ?? clampLogoBox(parsed.bbox);
    const confidence = Math.min(1, Math.max(0, finite(parsed.confidence) ?? 0));
    return {
      found: parsed.found && !!bbox,
      bbox,
      confidence: parsed.found ? confidence : 0,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────── prontidão para produzir ───────────────────────────

export interface McLogoFaceIssue {
  code: 'LOGO_BOX_REQUIRED';
  message: string;
  details: {
    actions: McLogoBoxAction[];
    source: McLogoBoxSource;
    logoBox: McProjectLogoBox | null;
  };
}

/**
 * Roteiro F1 com `logoFace: true` só produz com a caixa do logo CONFIRMADA
 * (layout, proposta confirmada ou marcação do usuário). Pura: devolve o
 * problema ou null — `assertLogoFaceReady` vira 422 na aprovação.
 */
export function logoFaceReadiness(
  project: { logoBox?: unknown },
  script: Pick<McScript, 'logoFace'> | null | undefined,
): McLogoFaceIssue | null {
  if (script?.logoFace !== true) return null;
  const box = readProjectLogoBox(project?.logoBox);
  if (box?.logoBoxConfirmed) return null;
  return {
    code: 'LOGO_BOX_REQUIRED',
    message: box
      ? 'Confirme a caixa do logo detectada na arte (ou marque outra) antes de produzir no modo rosto do logo.'
      : 'O modo rosto do logo precisa da caixa do logo na arte: detecte ou marque a caixa na prévia.',
    details: {
      actions: ['detect_logo_box', 'mark_logo_box'],
      source: box ? box.logoBoxSource : 'none',
      logoBox: box,
    },
  };
}

/** 422 LOGO_BOX_REQUIRED no formato dos bloqueios da aprovação (`details` + `issues`). */
export function assertLogoFaceReady(
  project: { logoBox?: unknown },
  script: Pick<McScript, 'logoFace'> | null | undefined,
): void {
  const issue = logoFaceReadiness(project, script);
  if (!issue) return;
  throw new HttpException(
    {
      code: issue.code,
      message: issue.message,
      details: issue.details,
      issues: [{ code: issue.code, sceneId: null, message: issue.message, detail: issue.details }],
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
