import type { SpikeConfig, Prices } from './config';
import { imageCostUsd, imagePrice, visionCostUsd, visionPrice } from './config';
import type { Arm } from './budget';
import type { EditParams, ImageResponse, SpikeOpenAi, VisionResponse } from './openai-client';
import { runPaidCall } from './paid-call';
import type { CallResult } from './paid-call';
import type { Session } from './session';

export interface Services {
  config: SpikeConfig;
  prices: Prices;
  client: SpikeOpenAi;
  session: Session;
}

interface Base {
  caseId: string;
  block: string;
  step: string;
}

/** Recusa rodar sem preço do modelo e da qualidade (fail-closed: sem preço o disjuntor não funciona). */
export function assertPriced(config: SpikeConfig, prices: Prices, needVision = false): void {
  imagePrice(prices, config.imageModel, config.quality);
  if (needVision) visionPrice(prices, config.visionModel);
}

export function paidGenerate(
  svc: Services,
  base: Base & { prompt: string; size: string },
): Promise<CallResult<ImageResponse>> {
  const { config, prices, client, session } = svc;
  const price = imagePrice(prices, config.imageModel, config.quality);
  const spec = {
    kind: 'generate' as const,
    ...base,
    provider: 'openai' as const,
    endpoint: 'images.generate',
    model: config.imageModel,
    quality: config.quality,
  };
  return runPaidCall(session.ctx, spec, async () => {
    const value = await client.generate({
      model: config.imageModel,
      prompt: base.prompt,
      size: base.size,
      quality: config.quality,
    });
    return {
      value,
      usage: value.usage,
      requestId: value.requestId,
      costUsd: imageCostUsd(price, value.usage),
    };
  });
}

export function paidEdit(
  svc: Services,
  base: Base & { arm?: Arm; params: Omit<EditParams, 'model' | 'quality'> },
): Promise<CallResult<ImageResponse>> {
  const { config, prices, client, session } = svc;
  const price = imagePrice(prices, config.imageModel, config.quality);
  const spec = {
    kind: 'edit' as const,
    caseId: base.caseId,
    block: base.block,
    step: base.step,
    arm: base.arm,
    provider: 'openai' as const,
    endpoint: 'images.edits',
    model: config.imageModel,
    size: base.params.size,
    quality: config.quality,
  };
  return runPaidCall(session.ctx, spec, async () => {
    const value = await client.edit({
      ...base.params,
      model: config.imageModel,
      quality: config.quality,
    });
    return {
      value,
      usage: value.usage,
      requestId: value.requestId,
      costUsd: imageCostUsd(price, value.usage),
    };
  });
}

export function paidVision(
  svc: Services,
  base: Base & { prompt: string; before: Buffer; after: Buffer },
): Promise<CallResult<VisionResponse>> {
  const { config, prices, client, session } = svc;
  const price = visionPrice(prices, config.visionModel);
  const spec = {
    kind: 'vision' as const,
    caseId: base.caseId,
    block: base.block,
    step: base.step,
    provider: 'openai' as const,
    endpoint: 'chat.completions',
    model: config.visionModel,
  };
  return runPaidCall(session.ctx, spec, async () => {
    const value = await client.vision({
      model: config.visionModel,
      prompt: base.prompt,
      before: base.before,
      after: base.after,
    });
    return {
      value,
      usage: value.usage,
      requestId: value.requestId,
      costUsd: visionCostUsd(price, value.usage),
    };
  });
}
