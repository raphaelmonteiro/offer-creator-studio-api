import { MC_SCRIPT_SCHEMA_V2 } from '../mc-quality';
import { sceneSourceHash } from '../mc-script-v2';
import {
  MC_ASPECT_RATIOS,
  MC_SCENES_ASPECT_RATIOS,
  McAspectRatio,
  McScenesAspectRatio,
  McScript,
  McScriptScene,
  McSceneType,
  McSealProduct,
} from '../mc-types';

/**
 * Fixtures de ROTEIRO do pipeline v2 (plano P0): presenter, action e
 * action_voiceover; três formatos; cena sem produto; produtos com nome/preço
 * longos e acentuados. Sem mídia de cliente — só texto sintético.
 *
 * Uso: testes de domínio/serviço e a rodada P5 (mesmos briefings para baseline
 * e candidato). Os `sceneId` são fixos para que hashes/snapshots sejam
 * comparáveis entre execuções.
 */

export const FIXTURE_PRODUCTS: McSealProduct[] = [
  {
    id: 'prod-arroz',
    catalogId: null,
    unit: 'pct',
    name: 'Arroz Tio João Integral Grãos Nobres 5kg',
    price: '24,90',
  },
  { id: 'prod-feijao', catalogId: null, unit: 'kg', name: 'Feijão Carioca Tipo 1', price: '8,99' },
  {
    id: 'prod-pao',
    catalogId: null,
    unit: 'un',
    name: 'Pão Francês Crocante Assado na Hora',
    price: '0,79',
  },
];

export const FIXTURE_LONG_PRODUCT: McSealProduct = {
  id: 'prod-longo',
  catalogId: null,
  unit: 'cx',
  name: 'Chocolate ao Leite com Avelãs Crocantes Edição Comemorativa 250g',
  price: '1.299,90',
};

function withDerived(
  scene: McScriptScene,
  en: { initialFrameEn: string | null; actionPromptEn: string },
): McScriptScene {
  return {
    ...scene,
    derived: {
      sourceHash: sceneSourceHash(scene),
      initialFrameEn: en.initialFrameEn,
      actionPromptEn: en.actionPromptEn,
      lang: 'en',
      provider: 'fixture',
      at: '2026-09-16T00:00:00.000Z',
    },
  };
}

export function fixtureScene(
  sceneId: string,
  idx: number,
  sceneType: McSceneType,
  opts: {
    initialFrame: string;
    initialFrameEn: string | null;
    actionPrompt: string;
    actionPromptEn: string;
    dialogue: string | null;
    durationS: number;
    productRef: string | null;
    sealCue?: { startS: number; endS: number } | null;
    safeArea?: 'lower_third' | 'left' | 'right';
    derived?: boolean;
  },
): McScriptScene {
  const base: McScriptScene = {
    idx,
    sceneId,
    sceneType,
    initialFrame: opts.initialFrame,
    camera: null,
    environmentId: null,
    productRef: opts.productRef,
    sealCue:
      opts.sealCue === undefined
        ? { startS: opts.durationS / 2, endS: opts.durationS }
        : opts.sealCue,
    safeArea: opts.safeArea ?? 'lower_third',
    actionPrompt: opts.actionPrompt,
    dialogue: opts.dialogue,
    durationS: opts.durationS,
  };
  return opts.derived === false
    ? base
    : withDerived(base, {
        initialFrameEn: opts.initialFrameEn,
        actionPromptEn: opts.actionPromptEn,
      });
}

/** Comercial completo (3 tipos + CTA sem oferta) — o caso principal de P5. */
export function fixtureCommercialScript(
  opts: { products?: McSealProduct[]; storeName?: string | null } = {},
): McScript {
  const products = opts.products ?? FIXTURE_PRODUCTS;
  return {
    version: 1,
    schemaVersion: MC_SCRIPT_SCHEMA_V2,
    products,
    environments: [
      {
        id: 'env-corredor',
        assetId: null,
        description: 'corredor de cereais de supermercado, luz branca uniforme',
        version: 1,
      },
    ],
    scenes: [
      fixtureScene('fx-scene-presenter', 0, 'presenter', {
        initialFrame:
          'O mascote de frente para a câmera no corredor de cereais, mãos livres, terço inferior livre.',
        initialFrameEn:
          'The mascot facing the camera in the cereal aisle, hands free, lower third of the frame clear.',
        actionPrompt: 'Acena para a câmera e sorri.',
        actionPromptEn: 'The mascot waves at the camera and smiles.',
        dialogue: 'Bem-vindo às ofertas da semana no nosso mercado!',
        durationS: 6,
        productRef: null,
      }),
      fixtureScene('fx-scene-voiceover', 1, 'action_voiceover', {
        initialFrame:
          'No mesmo corredor, um pacote de arroz na prateleira e a mão do mascote próxima dele.',
        initialFrameEn:
          "In the same aisle, a rice bag on the shelf with the mascot's hand close to it.",
        actionPrompt: 'Pega o pacote da prateleira e apresenta para a câmera.',
        actionPromptEn: 'The mascot picks the bag from the shelf and presents it to the camera.',
        dialogue: 'Arroz integral cinco quilos por vinte e quatro e noventa!',
        durationS: 5,
        productRef: 'prod-arroz',
        sealCue: { startS: 1.5, endS: 5 },
      }),
      fixtureScene('fx-scene-action', 2, 'action', {
        initialFrame:
          'Ainda no mesmo corredor, o mascote de corpo inteiro ao lado de uma pilha de feijão.',
        initialFrameEn: 'Still in the same aisle, the mascot full body next to a stack of beans.',
        actionPrompt: 'Aponta para a pilha e dá um joinha.',
        actionPromptEn: 'The mascot points at the stack and gives a thumbs up.',
        dialogue: null,
        durationS: 4,
        productRef: 'prod-feijao',
      }),
      fixtureScene('fx-scene-cta', 3, 'presenter', {
        initialFrame: 'O mascote na entrada do corredor, de frente, braços abertos.',
        initialFrameEn: 'The mascot at the aisle entrance, facing the camera, arms open.',
        actionPrompt: 'Abre os braços convidando o público.',
        actionPromptEn: 'The mascot opens its arms inviting the audience.',
        dialogue: 'Corre pro mercado que é só até domingo!',
        durationS: 5,
        productRef: null, // CTA sem oferta: NUNCA recebe selo
      }),
    ],
    seal: null,
    endcard:
      opts.storeName === undefined
        ? { storeName: 'Mercadão São João & Cia' }
        : opts.storeName
          ? { storeName: opts.storeName }
          : null,
  };
}

/** Uma cena independente por tipo (os 9 casos de P5 = 3 mascotes × estes 3). */
export function fixtureSingleSceneScript(sceneType: McSceneType): McScript {
  const full = fixtureCommercialScript();
  const scene = full.scenes.find(
    (s) => s.sceneType === sceneType && s.sceneId !== 'fx-scene-cta',
  ) as McScriptScene;
  return { ...full, scenes: [{ ...scene, idx: 0 }], endcard: null };
}

/** Cena com derivação PENDENTE (intenção editada após a tradução). */
export function fixturePendingDerivationScript(): McScript {
  const script = fixtureCommercialScript();
  script.scenes[1] = {
    ...script.scenes[1],
    actionPrompt: 'Larga o pacote na prateleira e se afasta.',
  };
  return script;
}

/** Produto de nome/preço longos e acentuados (legibilidade do selo). */
export function fixtureLongNamesScript(): McScript {
  const script = fixtureCommercialScript({ products: [FIXTURE_LONG_PRODUCT] });
  script.scenes = script.scenes.map((s) => ({
    ...s,
    productRef: s.sceneId === 'fx-scene-cta' ? null : 'prod-longo',
  }));
  return script;
}

/** Sem produtos: nenhuma cena pode ter selo; productRef = null em todas. */
export function fixtureNoProductsScript(): McScript {
  const script = fixtureCommercialScript({ products: [] });
  script.scenes = script.scenes.map((s) => ({ ...s, productRef: null }));
  return script;
}

/** Todos os aspectos do produto (4:5 incluído — formatos novos, design D12). */
export const FIXTURE_ASPECTS: McAspectRatio[] = [...MC_ASPECT_RATIOS];
/** Aspectos do formato `scenes` (F3): os que a montagem 720p (`assemblyDimensions`) conhece. */
export const FIXTURE_SCENES_ASPECTS: McScenesAspectRatio[] = [...MC_SCENES_ASPECT_RATIOS];
