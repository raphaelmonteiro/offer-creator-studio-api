import { CommercialsService } from '../commercials.service';
import { fixtureTalkTileScript } from '../domain/__fixtures__/mc-script-v2.fixtures';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { MC_STEP_CREDITS } from '../domain/mc-pricing.config';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { fakeManager } from './mc-fake-manager.fixture';
import { McMaterializerService } from './mc-materializer.service';

/** Bancada do `talk` por trecho (change video-fala-continua, 1.4): kit, tile, roteiro e projeto de teste. */
export const TALK_CREDITS = MC_STEP_CREDITS[McStepType.TALK];

const kit = {
  id: 'kit-1',
  userId: 'u1',
  version: 1,
  voiceId: 'voice-1',
  tileAssetId: 'tile-1',
  tileBackgroundColor: '#112233',
  identityMode: 'generated',
  source: 'mascot',
  style: '3d_render',
} as unknown as McCharacterKit;
const tile = { id: 'tile-1', fileUrl: '/uploads/tile.png', width: 720, height: 960 };

export function scriptWith(durationsMs: number[], continuous = true): McScript {
  const base = fixtureTalkTileScript({ backgroundColor: '#ff8800' });
  const scenes = durationsMs.map((_ms, i) => ({
    ...base.scenes[i % base.scenes.length],
    idx: i,
    sceneId: `fx-${i + 1}`,
    dialogue: `Fala número ${i + 1} do vídeo.`,
  }));
  return { ...base, scenes, ...(continuous ? { talkMode: 'continuous' as const } : {}) };
}

export function projectFor(script: McScript): McProject {
  return {
    id: 'proj-1',
    userId: 'u1',
    kitId: 'kit-1',
    aspectRatio: '4:5',
    pipelineVersion: MC_PIPELINE_V2,
    revision: 1,
    tier: 'economico',
    format: 'offer_piece',
    script,
    options: null,
  } as unknown as McProject;
}

export async function setup(
  durationsMs: number[],
  opts: { cache?: Parameters<typeof fakeManager>[0]['cache'] } = {},
) {
  const audios = durationsMs.map((ms, i) => ({ id: `au-${i + 1}`, durationMs: ms, metadata: {} }));
  const manager = fakeManager({ assets: [tile, ...audios], cache: opts.cache });
  manager.seed(McCharacterKit, [{ ...kit }]);
  const service = new McMaterializerService({
    appendEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as CommercialsService);
  const script = scriptWith(durationsMs);
  const project = projectFor(script);
  const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
  scenes.forEach((scene, i) => Object.assign(scene, { audioAssetId: `au-${i + 1}` }));
  return { manager, service, script, project, scenes };
}
