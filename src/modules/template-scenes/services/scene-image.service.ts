import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { erode } from '../../../shared/image/morphology';
import {
  bboxOf,
  cropRaster,
  Raster,
  resizeRaster,
  subtract,
  union,
} from '../../../shared/image/raster';
import { cropImg, Img, imgToPng, loadRgb, resizeImg } from '../../../shared/image/rgb';
import { CropPlan, computeCrop, insetOnScene } from '../domain/scene-region';
import {
  authorizedRegion,
  marginPx,
  rasterizeRegion,
  RegionSpec,
  renderEditMask,
  shapeAreaRatio,
} from '../domain/scene-shapes';
import { SceneZones } from '../domain/scene.types';
import { DEFAULT_TAU, diffRatioIn, diffRatioOutside, maxChannelDiff } from './scene-metrics';
import { recompose, verifyOutside } from './scene-recompose';

export const DEFAULT_FEATHER_PX = 48;
export const DEFAULT_MARGIN_RATIO = 0.04;
export const DEFAULT_INSET_PX = 40;
export const DEFAULT_NOOP_THRESHOLD = 0.02;

/** Métricas gravadas na versão (valores do spike: τ = 16 depois de um borrão 3x3). */
export interface SceneEditMetrics {
  /** Alterados dentro de S, na saída bruta; `null` se S não tem pixels no recorte enviado. */
  insideMaskDiffRatio: number | null;
  /** Alterados na faixa da margem (R \ S), no recomposto; `null` sem pixels (DT-11 b). */
  marginDiffRatio: number | null;
  /** SSIM da costura; `null` sem janelas de transição. */
  seamSsim: number | null;
  maskAreaRatio: number;
  /** Só diagnóstico: o preto que o modelo devolve fora da região não é ruído. */
  outsideMaskDiffRatio: number | null;
  /** A saída do modelo não veio no tamanho enviado e foi reamostrada. */
  sizeMismatch: boolean;
}

/** Tudo o que a recomposição precisa depois da chamada paga (a cena fica em memória, ~22 MB). */
export interface PreparedEdit {
  scene: Img;
  shape: Raster;
  authorized: Raster;
  plan: CropPlan;
  sent: Img;
  sentShape: Raster;
  sentAuthorized: Raster;
  /** Recorte enviado ao modelo e máscara (alfa 255 = editar), ambos PNG do tamanho enviado. */
  imagePng: Buffer;
  maskPng: Buffer;
  /** Máscara só com S (alfa 255 = S), para o provedor `mock` pintar apenas a forma (PV-30). */
  shapeMaskPng: Buffer;
}

export interface EditResult {
  /** Cena inteira recomposta, PNG. */
  finalPng: Buffer;
  /** Recortes antes e depois, no tamanho enviado, para a visão. */
  beforePng: Buffer;
  afterPng: Buffer;
  metrics: SceneEditMetrics;
  /** `insideMaskDiffRatio` abaixo do limiar: o modelo devolveu praticamente a mesma área. */
  noChange: boolean;
  plan: Pick<CropPlan, 'box' | 'sendW' | 'sendH' | 'scale' | 'grown' | 'downscaled' | 'stretched'>;
}

export interface SceneImageSettings {
  featherPx: number;
  marginRatio: number;
  insetPx: number;
  noopThreshold: number;
}

const numberFrom = (config: ConfigService, key: string, fallback: number): number => {
  const value = Number(config.get<string>(key, String(fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/**
 * Sequência PURA da edição local (M3 do spike), sem disco e sem rede: recorte → máscara → (chamada
 * paga fora daqui) → recomposição em `erode(A, 40/escala) ∪ S` com feather de 48 px → conferência
 * byte a byte → métricas. DT-11: sem variantes de investigação, `null` quando não há amostra, e τ
 * e o pior caso medidos no recomposto.
 */
@Injectable()
export class SceneImageService {
  constructor(private readonly config: ConfigService) {}

  settings(): SceneImageSettings {
    return {
      featherPx: numberFrom(this.config, 'TEMPLATE_SCENE_FEATHER_PX', DEFAULT_FEATHER_PX),
      marginRatio: numberFrom(this.config, 'TEMPLATE_SCENE_MARGIN_RATIO', DEFAULT_MARGIN_RATIO),
      insetPx: numberFrom(this.config, 'TEMPLATE_SCENE_INSET_PX', DEFAULT_INSET_PX),
      noopThreshold: numberFrom(
        this.config,
        'TEMPLATE_SCENE_NOOP_THRESHOLD',
        DEFAULT_NOOP_THRESHOLD,
      ),
    };
  }

  /** Decodifica a master, rasteriza a forma e monta o recorte e a máscara que vão ao modelo. */
  async prepareEdit(input: {
    master: Buffer;
    region: RegionSpec;
    zones: SceneZones;
  }): Promise<PreparedEdit> {
    const scene = await loadRgb(input.master);
    const shape = await rasterizeRegion(input.region, scene.width, scene.height, input.zones);
    const settings = this.settings();
    const authorized = authorizedRegion(
      shape,
      marginPx(settings.marginRatio, scene.width, scene.height),
    );
    const bbox = bboxOf(authorized);
    if (!bbox || !bboxOf(shape))
      throw new Error('Forma vazia: a região marcada não cobre nenhum pixel');
    const plan = computeCrop(scene.width, scene.height, bbox);
    const { box } = plan;
    const sent = await resizeImg(
      cropImg(scene, box.x, box.y, box.w, box.h),
      plan.sendW,
      plan.sendH,
    );
    const sentShape = resizeRaster(cropRaster(shape, box), plan.sendW, plan.sendH);
    const sentAuthorized = resizeRaster(cropRaster(authorized, box), plan.sendW, plan.sendH);
    return {
      scene,
      shape,
      authorized,
      plan,
      sent,
      sentShape,
      sentAuthorized,
      imagePng: await imgToPng(sent),
      maskPng: await renderEditMask(sentAuthorized),
      shapeMaskPng: await renderEditMask(sentShape),
    };
  }

  /** Recompõe a saída do modelo sobre a master e confere o exterior; lança `RecomposeMismatchError`. */
  async completeEdit(prepared: PreparedEdit, rawPng: Buffer): Promise<EditResult> {
    const settings = this.settings();
    const { plan, scene } = prepared;
    const decoded = await loadRgb(rawPng);
    const sizeMismatch = decoded.width !== plan.sendW || decoded.height !== plan.sendH;
    const rawSent = await resizeImg(decoded, plan.sendW, plan.sendH);
    const region = this.recomposeRegion(prepared, settings.insetPx);
    const rawCrop = await resizeImg(rawSent, plan.box.w, plan.box.h);
    const out = await recompose(scene, rawCrop, plan.box, region, settings.featherPx);
    verifyOutside(scene, out.final, region);
    const metrics = this.measure({
      prepared,
      rawSent,
      finalScene: out.final,
      region,
      sizeMismatch,
    });
    const finalCrop = cropImg(out.final, plan.box.x, plan.box.y, plan.box.w, plan.box.h);
    return {
      finalPng: await imgToPng(out.final),
      beforePng: prepared.imagePng,
      afterPng: await imgToPng(await resizeImg(finalCrop, plan.sendW, plan.sendH)),
      metrics: { ...metrics, seamSsim: out.seamSsim },
      noChange:
        metrics.insideMaskDiffRatio !== null &&
        metrics.insideMaskDiffRatio < settings.noopThreshold,
      plan: {
        box: plan.box,
        sendW: plan.sendW,
        sendH: plan.sendH,
        scale: plan.scale,
        grown: plan.grown,
        downscaled: plan.downscaled,
        stretched: plan.stretched,
      },
    };
  }

  /** R = erode(A, 40 / escala) ∪ S: o preto que o modelo põe na borda de A fica de fora. */
  private recomposeRegion(prepared: PreparedEdit, insetPx: number): Raster {
    const inset = insetOnScene(prepared.plan.scale, insetPx);
    return union(erode(prepared.authorized, inset), prepared.shape);
  }

  private measure(args: {
    prepared: PreparedEdit;
    rawSent: Img;
    finalScene: Img;
    region: Raster;
    sizeMismatch: boolean;
  }): Omit<SceneEditMetrics, 'seamSsim'> {
    const { prepared, rawSent, finalScene, region } = args;
    const { box } = prepared.plan;
    const sentDiff = maxChannelDiff(prepared.sent, rawSent);
    const originalCrop = cropImg(prepared.scene, box.x, box.y, box.w, box.h);
    const finalCrop = cropImg(finalScene, box.x, box.y, box.w, box.h);
    const margin: Raster = cropRaster(subtract(region, prepared.shape), box);
    return {
      insideMaskDiffRatio: diffRatioIn(sentDiff, prepared.sentShape, DEFAULT_TAU),
      marginDiffRatio: diffRatioIn(maxChannelDiff(originalCrop, finalCrop), margin, DEFAULT_TAU),
      maskAreaRatio: shapeAreaRatio(prepared.shape),
      outsideMaskDiffRatio: diffRatioOutside(sentDiff, prepared.sentAuthorized, DEFAULT_TAU),
      sizeMismatch: args.sizeMismatch,
    };
  }
}
