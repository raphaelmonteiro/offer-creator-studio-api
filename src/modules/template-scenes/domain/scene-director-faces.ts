import { DirectorPlan } from './scene-director-schema';
import { effectiveZone, FaceKey, SceneLayout } from './scene-faces';
import { SceneZones } from './scene.types';

/**
 * O que o Diretor e o código sabem da face do pedido (change add-template-scene-faces): zonas, estado das duas faces e
 * a regra de cada pedido que depende delas. Funções puras.
 */

/** A face do pedido e o estado das faces, lidos do banco ao montar o contexto do turno. */
export interface DirectorFace {
  layout: SceneLayout;
  key: FaceKey;
  zones: SceneZones;
  /** A face do pedido tem imagem (versão atual `ready` com master). */
  hasImage: boolean;
  /** A frente tem imagem: sem ela não há de onde derivar o verso. */
  frontReady: boolean;
  /** O verso tem versão `ready`. */
  backReady: boolean;
}

/** A face única de uma cena de uma face: o comportamento de sempre. */
export const isFrontBack = (face: Pick<DirectorFace, 'layout'> | undefined): boolean =>
  face?.layout === 'front_back';

/**
 * PV-9: zona que a face não tem (rodapé na frente, cabeçalho no verso) vira miolo, mantendo o lado, na região da
 * imagem e na posição das camadas do plano. O plano gravado em `metrics.plan` já é o convertido.
 */
export function applyFaceZones(plan: DirectorPlan, zones: SceneZones): DirectorPlan {
  const region = plan.image?.region;
  const image =
    plan.image && region
      ? { ...plan.image, region: { ...region, zone: effectiveZone(region.zone, zones) } }
      : plan.image;
  const layer_ops = plan.layer_ops.map((op) =>
    op.position
      ? { ...op, position: { ...op.position, zone: effectiveZone(op.position.zone, zones) } }
      : op,
  );
  return { ...plan, image, layer_ops };
}

/**
 * A face dos itens que o plano abre no brief (PV-8): só na cena de frente e verso. `fazer_verso` abre o pedido extra
 * ("com bandeirinhas") no verso; os demais turnos, na face do pedido. Cena de uma face não grava `faceKey`.
 */
export function briefFaceKey(
  plan: Pick<DirectorPlan, 'turn_kind'>,
  face: DirectorFace | undefined,
): FaceKey | undefined {
  if (!face || !isFrontBack(face)) return undefined;
  return plan.turn_kind === 'fazer_verso' ? 'back' : face.key;
}
