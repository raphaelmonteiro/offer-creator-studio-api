import { DirectorPlan } from './scene-director-schema';
import { effectiveZone, FaceKey, hasTwoFaces, SceneLayout } from './scene-faces';
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
  /** A primeira face (frente, Externa) tem imagem: sem ela não há de onde derivar a segunda. */
  frontReady: boolean;
  /** A segunda face (verso, Interna) tem versão `ready`. */
  backReady: boolean;
  /** Formato e altura nativa da face: o jornal escreve o fim do cabeçalho em px (D-1). */
  formatId?: string;
  heightPx?: number;
}

/** A cena tem duas faces (frente e verso, ou Externa e Interna)? A face única é o comportamento de sempre. */
export const isTwoFaces = (face: Pick<DirectorFace, 'layout'> | undefined): boolean =>
  Boolean(face) && hasTwoFaces((face as Pick<DirectorFace, 'layout'>).layout);

/**
 * PV-9: zona que a face não tem (rodapé na frente, cabeçalho no verso) vira miolo, mantendo o lado, na região da
 * imagem e na posição das camadas do plano. O plano gravado em `metrics.plan` já é o convertido. PV-T3: na Externa do
 * jornal, o rodapé é só da contracapa, então o rodapé pedido no lado da capa vai para o lado `left`.
 */
export function applyFaceZones(
  plan: DirectorPlan,
  zones: SceneZones,
  face?: Pick<DirectorFace, 'layout' | 'key'>,
): DirectorPlan {
  const cover = face?.layout === 'tabloid' && face.key === 'outer';
  const sideOf = <S extends string | null>(zone: string, side: S): S | 'left' =>
    cover && effectiveZone(zone, zones) === 'footer' ? 'left' : side;
  // D-10: faixa embaixo na capa (rodapé com lado `right`) é pintada na capa: a região vira o miolo da capa.
  const zoneOf = (zone: string, side: string | null): string =>
    cover && effectiveZone(zone, zones) === 'footer' && side === 'right'
      ? 'body'
      : effectiveZone(zone, zones);
  const region = plan.image?.region;
  const image =
    plan.image && region
      ? {
          ...plan.image,
          region: {
            ...region,
            zone: zoneOf(region.zone, region.side) as typeof region.zone,
            side:
              zoneOf(region.zone, region.side) === 'body'
                ? region.side
                : sideOf(region.zone, region.side),
          },
        }
      : plan.image;
  const layer_ops = plan.layer_ops.map((op) =>
    op.position
      ? {
          ...op,
          position: {
            ...op.position,
            zone: effectiveZone(op.position.zone, zones),
            side: sideOf(op.position.zone, op.position.side),
          },
        }
      : op,
  );
  return { ...plan, image, layer_ops };
}

/**
 * A face dos itens que o plano abre no brief (PV-8): só na cena de duas faces. `fazer_verso` abre o pedido extra
 * ("com bandeirinhas") no verso; os demais turnos, na face do pedido. Cena de uma face não grava `faceKey`.
 */
export function briefFaceKey(
  plan: Pick<DirectorPlan, 'turn_kind'>,
  face: DirectorFace | undefined,
): FaceKey | undefined {
  if (!face || !isTwoFaces(face)) return undefined;
  if (plan.turn_kind !== 'fazer_verso') return face.key;
  return face.layout === 'tabloid' ? 'inner' : 'back';
}
