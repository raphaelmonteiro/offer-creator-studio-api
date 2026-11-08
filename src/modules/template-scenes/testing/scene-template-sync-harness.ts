import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SceneTemplateConfiguration } from '../domain/scene-template.types';
import { SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { Template } from '../../templates/entities/template.entity';
import { SceneTemplateSyncProcessor } from '../processors/scene-template-sync.processor';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneTemplateFilesService } from '../services/scene-template-files.service';
import { insertAsset } from './scene-fixtures';
import { useProcessorHarness } from './scene-processor-harness';
import { solidPng } from './scene-template-fixtures';

export const CDN = 'http://cdn.test/uploads';

/**
 * Banco, arquivos em pasta temporária e o `SceneTemplateSyncProcessor` real, para os specs do job de sincronização
 * do template. Chame dentro do `describeIfSceneDb`. Cenas de 384x768 (a proporção do folheto, leve para o `sharp`).
 */
export function useSyncHarness() {
  const base = useProcessorHarness();
  // Preenchidos no `beforeAll`, na própria `base` (que o spec recebe), para quem lê depois do setup.
  const built = base as typeof base & {
    processor: SceneTemplateSyncProcessor;
    templateFiles: SceneTemplateFilesService;
    locks: SceneLockService;
  };

  beforeAll(() => {
    const config = new ConfigService({ UPLOAD_DEST: base.uploadsDir, CDN_URL: CDN });
    built.locks = new SceneLockService(base.dataSource);
    built.templateFiles = new SceneTemplateFilesService(config, base.files);
    built.processor = new SceneTemplateSyncProcessor(
      base.dataSource,
      built.locks,
      base.files,
      built.templateFiles,
    );
  });

  const sync = (sceneId: string) => built.processor.process({ sceneId }, 'job-sync');

  /** O template da cena pelo marcador `source.sceneId` (há no máximo um). */
  async function templatesOf(sceneId: string): Promise<Template[]> {
    return base.dataSource.manager
      .createQueryBuilder(Template, 'template')
      .where(`template.configuration->'source'->>'sceneId' = :sceneId`, { sceneId })
      .getMany();
  }

  async function templateOf(
    sceneId: string,
  ): Promise<Template & { config: SceneTemplateConfiguration }> {
    const [template] = await templatesOf(sceneId);
    return Object.assign(template, {
      config: template.configuration as SceneTemplateConfiguration,
    });
  }

  /** Arquivos do template da cena em disco (caminhos relativos a `uploads/`), de todas as projeções. */
  async function filesOf(sceneId: string): Promise<string[]> {
    const root = path.join(base.uploadsDir, 'templates', `scene-${sceneId}`);
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const nested = await Promise.all(
        entries.map((entry) =>
          entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
        ),
      );
      return nested.flat().map((file) => path.relative(base.uploadsDir, file));
    };
    return (await walk(root)).sort();
  }

  const fileOfUrl = (url: string) =>
    fs.readFile(path.join(base.uploadsDir, url.replace(`${CDN}/`, '')));

  /** Torna a versão atual como o fluxo real: aponta a cena e sobe a `revision` (sem passar pelo job). */
  async function makeCurrent(sceneId: string, versionId: string): Promise<void> {
    await base.dataSource.query(
      `UPDATE template_scenes SET "currentVersionId" = $1, revision = revision + 1 WHERE id = $2`,
      [versionId, sceneId],
    );
    await base.dataSource.query(
      `UPDATE template_scene_faces SET "currentVersionId" = $1 WHERE "sceneId" = $2 AND "index" = 0`,
      [versionId, sceneId],
    );
  }

  const bumpRevision = (sceneId: string) =>
    base.dataSource.query(`UPDATE template_scenes SET revision = revision + 1 WHERE id = $1`, [
      sceneId,
    ]);

  /** Nova versão `ready` com master própria (cor sólida), atual. */
  async function newImageVersion(
    scene: { id: string; widthPx: number; heightPx: number },
    number: number,
    color: [number, number, number],
    elements: SceneElement[] = [],
  ) {
    const parent = (await base.sceneOf(scene.id)).currentVersionId;
    const made = await base.readyVersionLike(
      scene,
      number,
      parent,
      await solidPng(scene.widthPx, scene.heightPx, color),
      elements,
    );
    await makeCurrent(scene.id, made.version.id);
    return made.version;
  }

  /** Logo de PNG sólido gravada como asset da cena. */
  async function addLogoAsset(
    scene: { id: string },
    version: TemplateSceneVersion,
    color: [number, number, number] = [250, 250, 0],
  ) {
    const written = await base.files.write(
      scene.id,
      version.id,
      `logo-${randomUUID()}.png`,
      await solidPng(60, 30, color),
    );
    return insertAsset(base.dataSource, version, 'logo', {
      url: written.url,
      width: 60,
      height: 30,
    });
  }

  const setElements = (versionId: string, elements: SceneElement[]) =>
    base.dataSource.manager.update(TemplateSceneVersion, { id: versionId }, { elements });

  const sceneRow = (id: string) => base.dataSource.manager.findOneByOrFail(TemplateScene, { id });

  return Object.assign(built, {
    sync,
    templatesOf,
    templateOf,
    filesOf,
    fileOfUrl,
    makeCurrent,
    bumpRevision,
    newImageVersion,
    addLogoAsset,
    setElements,
    sceneRow,
    /** Cena de 384x768 com a versão 1 `ready` (master sintética) e `elements`. */
    readySmall: (elements: SceneElement[] = []) =>
      base.readyScene({ width: 384, height: 768, elements }),
  });
}
