import { KIT_REFERENCE_SLOTS, KIT_SLOT_WITH_PROP } from './kit-prompts';
import { McReferenceRole, McSelectedReference } from './mc-quality';
import { McSceneType } from './mc-types';

/**
 * Seleção de referências por FUNÇÃO (ADR-001 §3.4 / plano P4) — função pura.
 * Substitui a seleção legada "até três por ordem de slot", que deixava a
 * referência de interação (slot 3) de fora sempre que os slots anteriores
 * existiam e ignorava o tipo da cena.
 *
 * Papéis e origem:
 * - identity    → slot 0 (¾ esquerda): SEMPRE primeiro.
 * - product     → foto real do produto anunciado (catálogo/galeria), logo após a
 *                 identidade: define a embalagem que o mascote segura.
 * - interaction → slot 3 (segurando produto): quando a cena anuncia um produto
 *                 ou o movimento descreve pegar/segurar/mostrar.
 * - expression  → slot 2 (pose de fala): cenas `presenter`.
 * - environment → asset do cenário aprovado, quando existe.
 * - angle       → slot 1 (perfil): quando a câmera pede lateral, senão
 *                 preenche vaga restante.
 * - original    → imagem original do mascote, SÓ quando `includeOriginal`
 *                 (experimento controlado do P4: pode reintroduzir acessórios).
 *
 * O limite total respeita o adaptador (`maxReferences`); nada é adicionado
 * indiscriminadamente. Quando o slot desejado não existe no kit, o fallback
 * fica AUDITADO no `reason`.
 */
export interface KitReferenceInput {
  assetId: string;
  slot: number | null;
}

export interface SelectReferencesInput {
  sceneType: McSceneType;
  hasProduct: boolean;
  motionPrompt: string;
  camera?: string | null;
  kitReferences: KitReferenceInput[];
  /** Foto real do produto anunciado na cena (URL em /uploads/*). */
  productImageUrl?: string | null;
  environmentAssetId?: string | null;
  originalAssetId?: string | null;
  includeOriginal?: boolean;
  maxReferences: number;
}

const INTERACTION_HINT =
  /\b(pega|pegar|segura|segurar|mostra|mostrar|apresenta|apresentar|levanta|ergue|entrega|holds?|holding|picks?\s*up|grabs?|shows?|presents?|lifts?)\b/i;
const SIDE_CAMERA_HINT = /\b(perfil|lateral|de lado|side|profile)\b/i;

function slotAsset(refs: KitReferenceInput[], slot: number): KitReferenceInput | null {
  return refs.find((r) => r.slot === slot) ?? null;
}

export function selectReferences(input: SelectReferencesInput): McSelectedReference[] {
  const max = Math.max(1, input.maxReferences);
  const selected: McSelectedReference[] = [];
  const used = new Set<string>();
  const push = (
    ref: KitReferenceInput | { assetId: string; slot: number | null; fileUrl?: string } | null,
    role: McReferenceRole,
    reason: string,
  ): boolean => {
    if (!ref || used.has(ref.assetId) || selected.length >= max) return false;
    used.add(ref.assetId);
    selected.push({
      assetId: ref.assetId,
      role,
      slot: ref.slot,
      reason,
      ...('fileUrl' in ref && ref.fileUrl ? { fileUrl: ref.fileUrl } : {}),
    });
    return true;
  };

  const wantsInteraction = input.hasProduct || INTERACTION_HINT.test(input.motionPrompt);
  const wantsExpression = input.sceneType === 'presenter';
  const wantsSideAngle = SIDE_CAMERA_HINT.test(input.camera ?? '');

  // 1. identidade — sempre.
  const identity = slotAsset(input.kitReferences, 0);
  if (!push(identity, 'identity', `slot 0 (${KIT_REFERENCE_SLOTS[0]})`)) {
    // fallback auditado: qualquer referência do kit sustenta a identidade.
    const any = input.kitReferences.find((r) => !used.has(r.assetId)) ?? null;
    push(any, 'identity', 'slot 0 ausente — fallback para a primeira referência disponível');
  }

  // 2. FOTO REAL do produto anunciado (ADR §3.4/§3.6): é ela que define a
  //    embalagem que o mascote segura — vem antes da pose genérica do kit.
  if (input.productImageUrl) {
    push(
      { assetId: `product:${input.productImageUrl}`, slot: null, fileUrl: input.productImageUrl },
      'product',
      'foto do produto anunciado na cena (embalagem real)',
    );
  }

  // 3. interação com produto (a lacuna do legado).
  let interactionMissing = false;
  if (wantsInteraction) {
    const prop = slotAsset(input.kitReferences, KIT_SLOT_WITH_PROP);
    const added = push(
      prop,
      'interaction',
      `slot ${KIT_SLOT_WITH_PROP} (${KIT_REFERENCE_SLOTS[3]}): cena com produto/ação de segurar`,
    );
    interactionMissing = !added && !prop;
  }

  // 4. expressão de fala para presenter.
  if (wantsExpression) {
    push(
      slotAsset(input.kitReferences, 2),
      'expression',
      `slot 2 (${KIT_REFERENCE_SLOTS[2]}): cena presenter`,
    );
  }

  // 5. cenário aprovado.
  if (input.environmentAssetId) {
    push(
      { assetId: input.environmentAssetId, slot: null },
      'environment',
      'cenário aprovado do roteiro',
    );
  }

  // 6. ângulo: perfil quando a câmera pede; senão preenche vaga.
  const profile = slotAsset(input.kitReferences, 1);
  if (wantsSideAngle) push(profile, 'angle', `slot 1 (${KIT_REFERENCE_SLOTS[1]}): câmera lateral`);

  // 7. original do mascote — experimento controlado.
  if (input.includeOriginal && input.originalAssetId) {
    push(
      { assetId: input.originalAssetId, slot: null },
      'identity',
      'imagem original (experimento P4: incluir original)',
    );
  }

  // 8. preenchimento com o que sobrou do kit, por ordem de slot, sem passar do limite.
  const remaining = [...input.kitReferences].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  for (const ref of remaining) {
    if (selected.length >= max) break;
    const role: McReferenceRole =
      ref.slot === 1
        ? 'angle'
        : ref.slot === 2
          ? 'expression'
          : ref.slot === 3
            ? 'interaction'
            : 'identity';
    const suffix = interactionMissing
      ? ' (slot 3 de interação ausente no kit — fallback auditado)'
      : '';
    push(ref, role, `slot ${ref.slot ?? '?'}: preenchimento até o limite do adaptador${suffix}`);
  }

  return selected.slice(0, max);
}

/** Limite de referências enviadas ao gerador de keyframe (configurável; default do plano B1b = 3). */
export function keyframeReferenceLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MC_KEYFRAME_MAX_REFERENCES);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(8, Math.floor(raw)) : 3;
}
