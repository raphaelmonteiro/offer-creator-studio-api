import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as sharp from 'sharp';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { DirectorFace } from '../domain/scene-director-faces';
import { DirectorScript } from '../providers/scene-director-client';
import {
  boxText,
  facesBlock,
  formatBlock,
  HistoryEntry,
  historyBlock,
  layerBox,
  markingOf,
  oneLine,
  paintedBlock,
  paintedLinesOf,
  paintedTextOf,
  briefBlock,
  versionsBlock,
} from './scene-director-blocks';
import { DisplayedVersion, loadDisplayedVersions } from './scene-display-number';
import { currentVersionOf, faceHasImage, loadFaces } from './scene-faces';
import { SceneFilesService } from './scene-files.service';
import { readVersionMaster } from './scene-master';

export { formatBlock, markingOf, paintedTextOf } from './scene-director-blocks';

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
  /** Linhas pintadas a pedido e conferidas na versão atual (`metrics.paintedText`), fonte da validação 4. */
  paintedText: string[];
  /** Texto de cada camada de texto da versão atual: fonte só da linha igual a ele, inteira (D-55, validação 4a). */
  layerTexts: string[];
  /** Nome de cada camada da cena (validação 9: citar o nome entre aspas no anúncio não é frase a pintar). */
  layerNames: string[];
  /** A face do pedido e o estado das faces: zonas, `fazer_verso` e o pedido no verso vazio (PV-9, PV-14). */
  face?: DirectorFace;
}

/**
 * Contexto do Diretor, tudo do nosso banco (D-23): últimas 30 mensagens com a versão que gerou cada uma e
 * a marcação usada, a lista do que o cliente pediu, o resumo das versões com o número exibido, a imagem
 * atual em JPEG, a marcação desta mensagem, as camadas e o elemento selecionado (só uma dica de camada). Tudo da face
 * do pedido (imagem, camadas, zonas, versões); a conversa e a lista de pedidos são da cena inteira, com o rótulo da face.
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
    const faces = await loadFaces(manager, scene.id);
    const face = faces.find((item) => item.index === version.faceIndex) ?? faces[0];
    const frontBack = scene.layout === 'front_back';
    const [current, messages, allVersions, currentMessage, clientMessages] = await Promise.all([
      currentVersionOf(manager, face),
      this.recentMessages(manager, scene.id, version.id),
      loadDisplayedVersions(manager, scene.id),
      manager.findOne(TemplateSceneMessage, {
        where: { versionId: version.id, role: 'user' },
        order: { createdAt: 'ASC' },
      }),
      this.clientMessages(manager, scene.id),
    ]);
    const aspect = scene.heightPx / scene.widthPx;
    const versions = allVersions.filter((item) => item.faceIndex === face.index);
    const history = await this.history(
      manager,
      { messages, versions: allVersions, aspect },
      frontBack,
    );
    const faceState = await this.faceState(manager, scene, { face, current });
    const layers = current?.elements ?? [];
    const marking = markingOf(version, aspect);
    const content = currentMessage?.content ?? '';
    const attachments = currentMessage?.attachments ?? [];
    const text = [
      historyBlock(history),
      briefBlock(scene.brief ?? [], frontBack),
      versionsBlock(versions, face.currentVersionId, frontBack ? face.key : 'single'),
      ...(frontBack ? [facesBlock({ key: face.key, hasImage: faceState.hasImage })] : []),
      formatBlock(scene, face.zones),
      paintedBlock(paintedLinesOf(current)),
      marking
        ? `Marcação do cliente na imagem atual (frações 0..1): tipo=${marking.kind} ${boxText(marking.box)}`
        : 'Marcação do cliente: nenhuma.',
      layers.length
        ? `Camadas (ficam fora da imagem): ${JSON.stringify(
            layers.map((l) => ({
              id: l.id,
              nome: l.name,
              tipo: l.kind,
              // O texto de uma camada de texto é dado, nunca instrução; só serve de fonte da linha igual a ele (4a, D-55).
              ...(l.kind === 'text' ? { texto: l.text } : {}),
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
      paintedText: paintedTextOf(current),
      layerTexts: layers.flatMap((l) => (l.kind === 'text' && l.text ? [l.text] : [])),
      layerNames: layers.map((l) => l.name),
      face: faceState,
      script: {
        layout: scene.layout,
        face: face.key,
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

  /** A face do pedido e o estado das duas faces (a frente pronta e o verso pronto). */
  private async faceState(
    manager: EntityManager,
    scene: TemplateScene,
    input: {
      face: { key: DirectorFace['key']; zones: DirectorFace['zones'] };
      current: TemplateSceneVersion | null;
    },
  ): Promise<DirectorFace> {
    const { face, current } = input;
    const frontBack = scene.layout === 'front_back';
    return {
      layout: scene.layout,
      key: face.key,
      zones: face.zones,
      hasImage: current?.status === 'ready' && Boolean(current.masterAssetId),
      frontReady: frontBack ? await faceHasImage(manager, scene.id, 0) : true,
      backReady: frontBack ? await faceHasImage(manager, scene.id, 1) : false,
    };
  }

  private async history(
    manager: EntityManager,
    input: { messages: TemplateSceneMessage[]; versions: DisplayedVersion[]; aspect: number },
    frontBack: boolean,
  ): Promise<HistoryEntry[]> {
    const { messages, versions, aspect } = input;
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
        ...(frontBack ? { faceLabel: message.faceIndex === 1 ? 'Verso' : 'Frente' } : {}),
      };
    });
  }

  /** Master da versão atual em JPEG, até 1.536 px; `null` sem imagem ou com o arquivo apagado. */
  private async currentImage(
    manager: EntityManager,
    current: TemplateSceneVersion | null,
  ): Promise<Buffer | null> {
    const master = await readVersionMaster(manager, this.files, current);
    if (!master) return null;
    try {
      return await sharp(master)
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
