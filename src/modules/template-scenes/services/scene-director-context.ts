import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as sharp from 'sharp';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { BriefItem } from '../domain/scene-brief';
import { maskBounds } from '../domain/scene-mask-shape';
import { MaskShape, Rect, SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { DirectorScript } from '../providers/scene-director-client';
import { DisplayedVersion, loadDisplayedVersions } from './scene-display-number';
import { SceneFilesService } from './scene-files.service';

/** Mensagens anteriores que o Diretor recebe (a conversa inteira continua na tela, sob demanda). */
export const DIRECTOR_RECENT_MESSAGES = 30;
/** Maior lado da imagem enviada ao Diretor (como no teste da Etapa 0). */
export const DIRECTOR_IMAGE_EDGE = 1536;

export interface DirectorContext {
  /** Mensagem do turno, em texto (`input_text`). */
  text: string;
  /** JPEG da imagem atual; `null` na cena sem imagem ou com a master apagada. */
  image: Buffer | null;
  /** O que o `mock` lê. */
  script: DirectorScript;
  /** Todas as mensagens do cliente, para as validações 3 e 5. */
  clientMessages: string[];
  /** A lista do que o cliente pediu, com id e texto. */
  briefItems: Array<{ id: string; text: string }>;
}

const frac = (value: number): string => value.toFixed(2);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const boxText = (box: Rect): string =>
  `x0=${frac(box.x)} y0=${frac(box.y)} x1=${frac(box.x + box.w)} y1=${frac(box.y + box.h)}`;

interface Marking {
  kind: 'retângulo' | 'pincel' | 'laço';
  box: Rect;
}

/** A marcação gravada na versão: forma (pincel e laço) ou retângulo (retângulo e zona). */
export function markingOf(
  version: Pick<TemplateSceneVersion, 'requestedRegion' | 'requestedMask'>,
  sceneAspect: number,
): Marking | null {
  const mask: MaskShape | null = version.requestedMask;
  if (mask) {
    return {
      kind: mask.kind === 'brush' ? 'pincel' : 'laço',
      box: version.requestedRegion ?? maskBounds(mask, sceneAspect),
    };
  }
  return version.requestedRegion ? { kind: 'retângulo', box: version.requestedRegion } : null;
}

/** Caixa da camada em frações da cena (o `x`, `y` é o centro e `w` a largura). */
function layerBox(layer: SceneElement, scene: Pick<TemplateScene, 'widthPx' | 'heightPx'>): Rect {
  const h = (layer.w * scene.widthPx) / layer.aspect / scene.heightPx;
  return { x: layer.x - layer.w / 2, y: layer.y - h / 2, w: layer.w, h };
}

const OPERATION_LABEL: Record<string, string> = {
  generate: 'gerada',
  redraw: 'redesenhada',
  manual: 'ajuste manual',
  set_layer: 'camada alterada',
  restore: 'restaurada',
};

/** Resumo das versões: número exibido, operação e data, para "é a versão 7?" e "volta para a 3". */
function versionsBlock(versions: DisplayedVersion[], currentId: string | null): string {
  if (versions.length === 0) return 'Versões da cena: nenhuma imagem ainda.';
  const lines = versions.map(
    (v) =>
      `- Versão ${v.displayNumber}: ${OPERATION_LABEL[v.operation] ?? v.operation} em ${v.createdAt.toISOString().slice(0, 16).replace('T', ' ')}${v.id === currentId ? ' (a atual)' : ''}`,
  );
  return `Versões da cena (número exibido):\n${lines.join('\n')}`;
}

function briefBlock(brief: BriefItem[]): string {
  const open = brief.filter((item) => item.status === 'open');
  const closed = brief.filter((item) => item.status !== 'open').slice(-10);
  const lines = [
    open.length
      ? `Pedidos do cliente ainda em aberto:\n${open.map((i) => `- ${i.id}: ${oneLine(i.text)}`).join('\n')}`
      : 'Pedidos do cliente ainda em aberto: nenhum.',
  ];
  if (closed.length) {
    lines.push(
      `Pedidos já resolvidos ou desistidos (só contexto):\n${closed
        .map(
          (i) => `- ${i.id} (${i.status === 'done' ? 'feito' : 'desistido'}): ${oneLine(i.text)}`,
        )
        .join('\n')}`,
    );
  }
  return lines.join('\n');
}

interface HistoryEntry {
  message: TemplateSceneMessage;
  displayNumber: number | null;
  marking: Marking | null;
}

function historyBlock(entries: HistoryEntry[]): string {
  if (entries.length === 0) return 'Histórico da conversa: nenhuma mensagem anterior.';
  const lines = entries.map(({ message, displayNumber, marking }) => {
    const who = message.role === 'user' ? 'Cliente' : 'Assistente';
    const notes: string[] = [];
    if (displayNumber !== null) notes.push(`versão ${displayNumber}`);
    if (marking) notes.push(`com marcação (${marking.kind}, ${boxText(marking.box)})`);
    return `${who}${notes.length ? ` [${notes.join(', ')}]` : ''}: ${oneLine(message.content)}`;
  });
  return `Histórico da conversa:\n${lines.join('\n')}`;
}

/**
 * Contexto do Diretor, tudo do nosso banco (D-23): últimas 30 mensagens com a versão que gerou cada uma e
 * a marcação usada, a lista do que o cliente pediu, o resumo das versões com o número exibido, a imagem
 * atual em JPEG, a marcação desta mensagem, as camadas e o elemento selecionado (só uma dica de camada).
 * Texto de mensagem, de camada e de imagem é dado, nunca instrução.
 */
@Injectable()
export class SceneDirectorContextService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly files: SceneFilesService,
  ) {}

  async build(scene: TemplateScene, version: TemplateSceneVersion): Promise<DirectorContext> {
    const manager = this.dataSource.manager;
    const [current, messages, versions, currentMessage, clientMessages] = await Promise.all([
      scene.currentVersionId
        ? manager.findOne(TemplateSceneVersion, { where: { id: scene.currentVersionId } })
        : null,
      this.recentMessages(manager, scene.id, version.id),
      loadDisplayedVersions(manager, scene.id),
      manager.findOne(TemplateSceneMessage, {
        where: { versionId: version.id, role: 'user' },
        order: { createdAt: 'ASC' },
      }),
      this.clientMessages(manager, scene.id),
    ]);
    const aspect = scene.heightPx / scene.widthPx;
    const history = await this.history(manager, messages, versions, aspect);
    const layers = current?.elements ?? [];
    const marking = markingOf(version, aspect);
    const content = currentMessage?.content ?? '';
    const attachments = currentMessage?.attachments ?? [];
    const text = [
      historyBlock(history),
      briefBlock(scene.brief ?? []),
      versionsBlock(versions, scene.currentVersionId),
      marking
        ? `Marcação do cliente na imagem atual (frações 0..1): tipo=${marking.kind} ${boxText(marking.box)}`
        : 'Marcação do cliente: nenhuma.',
      layers.length
        ? `Camadas (ficam fora da imagem): ${JSON.stringify(
            layers.map((l) => ({
              id: l.id,
              nome: l.name,
              tipo: l.kind,
              caixa: boxText(layerBox(l, scene)),
            })),
          )}`
        : 'Camadas: nenhuma.',
      version.targetElementId
        ? `Elemento selecionado pelo cliente (dica de camada, não é marcação): ${version.targetElementId}`
        : 'Elemento selecionado: nenhum.',
      attachments.length ? `Anexos da mensagem: ${attachments.length} logo(s).` : 'Anexos: nenhum.',
      `Mensagem atual do cliente: ${oneLine(content)}`,
    ].join('\n\n');
    return {
      text,
      image: await this.currentImage(manager, current),
      clientMessages: [...clientMessages, ...(clientMessages.includes(content) ? [] : [content])],
      briefItems: (scene.brief ?? []).map((item) => ({ id: item.id, text: item.text })),
      script: {
        message: content,
        hasImage: Boolean(current?.masterAssetId),
        marked: marking !== null,
        openRequests: (scene.brief ?? [])
          .filter((item) => item.status === 'open')
          .map((item) => ({ id: item.id, text: item.text })),
        layers: layers.map((l) => ({ id: l.id, kind: l.kind, name: l.name })),
        hasLogoAttachment: attachments.length > 0,
      },
    };
  }

  /** As últimas 30 mensagens antes desta (em ordem cronológica); `role` mantém o usuário antes do assistente (PV-21). */
  private async recentMessages(manager: EntityManager, sceneId: string, versionId: string) {
    const rows = await manager.find(TemplateSceneMessage, {
      where: { sceneId, versionId: Not(versionId) },
      order: { createdAt: 'DESC', role: 'ASC' },
      take: DIRECTOR_RECENT_MESSAGES,
    });
    return rows.reverse();
  }

  private async clientMessages(manager: EntityManager, sceneId: string): Promise<string[]> {
    const rows = await manager.find(TemplateSceneMessage, {
      where: { sceneId, role: 'user' },
      select: { content: true, createdAt: true },
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => row.content);
  }

  private async history(
    manager: EntityManager,
    messages: TemplateSceneMessage[],
    versions: DisplayedVersion[],
    aspect: number,
  ): Promise<HistoryEntry[]> {
    const ids = [...new Set(messages.map((m) => m.versionId).filter(Boolean))] as string[];
    const sources = ids.length ? await manager.findBy(TemplateSceneVersion, { id: In(ids) }) : [];
    const byId = new Map(sources.map((v) => [v.id, v]));
    const display = new Map(versions.map((v) => [v.id, v.displayNumber]));
    return messages.map((message) => {
      const source = message.versionId ? byId.get(message.versionId) : undefined;
      return {
        message,
        displayNumber: message.versionId ? (display.get(message.versionId) ?? null) : null,
        marking: message.role === 'user' && source ? markingOf(source, aspect) : null,
      };
    });
  }

  /** Master da versão atual em JPEG, até 1.536 px; `null` sem imagem ou com o arquivo apagado. */
  private async currentImage(
    manager: EntityManager,
    current: TemplateSceneVersion | null,
  ): Promise<Buffer | null> {
    if (!current?.masterAssetId) return null;
    const master = await manager.findOne(TemplateSceneAsset, {
      where: { id: current.masterAssetId },
    });
    if (!master || master.purgedAt) return null;
    try {
      return await sharp(await this.files.read(master.url))
        .resize({
          width: DIRECTOR_IMAGE_EDGE,
          height: DIRECTOR_IMAGE_EDGE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      return null;
    }
  }
}
