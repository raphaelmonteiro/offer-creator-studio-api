import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { facesOfLayout, SceneLayout } from '../../modules/template-scenes/domain/scene-faces';
import {
  nativeSizeOfFormat,
  pixelsPerCm,
} from '../../modules/template-scenes/domain/scene-format-size';
import {
  findSceneFormat,
  SceneFormatSpec,
} from '../../modules/template-scenes/domain/scene-formats';
import { TemplateScene } from '../../modules/template-scenes/entities/template-scene.entity';
import { TemplateSceneFace } from '../../modules/template-scenes/entities/template-scene-face.entity';
import { SceneTemplateConfiguration } from '../../modules/template-scenes/domain/scene-template.types';
import { TemplateSceneAsset } from '../../modules/template-scenes/entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../../modules/template-scenes/entities/template-scene-version.entity';
import { Template } from '../../modules/templates/entities/template.entity';
import { SceneTemplateSyncProcessor } from '../../modules/template-scenes/processors/scene-template-sync.processor';
import { SceneFilesService } from '../../modules/template-scenes/services/scene-files.service';
import { SceneLockService } from '../../modules/template-scenes/services/scene-lock.service';
import { buildSceneOutputs } from '../../modules/template-scenes/services/scene-output';
import { SceneTemplateFilesService } from '../../modules/template-scenes/services/scene-template-files.service';
import {
  insertAsset,
  insertScene,
  insertVersion,
  pointFace,
} from '../../modules/template-scenes/testing/scene-fixtures';
import { solidPng, Rgb } from '../../modules/template-scenes/testing/scene-template-fixtures';
import { deleteTestScenes } from '../../modules/template-scenes/testing/scene-test-db';

export interface SeededFace {
  key: string;
  index: number;
  versionId: string;
  templateId: string;
}

export interface SeededScene {
  id: string;
  name: string;
  formatId: string;
  layout: SceneLayout;
  faces: SeededFace[];
}

export interface SceneSpec {
  name: string;
  formatId: string;
  layout: SceneLayout;
  /** Cor da arte de cada face, na ordem das faces do layout. */
  colors: Rgb[];
}

/** Pasta de uploads e endereço público de onde saem os arquivos da arte e dos templates. */
export interface SeedFileTarget {
  uploadsDir: string;
  cdnUrl: string;
}

/** O que a semente precisa para projetar os templates: os serviços reais do módulo, sem Nest nem fila. */
export interface SceneSeeder {
  dataSource: DataSource;
  target: SeedFileTarget;
  files: SceneFilesService;
  sync: SceneTemplateSyncProcessor;
}

/** `ConfigService` mínimo: só `UPLOAD_DEST` e `CDN_URL`, sem ler o `process.env` do shell. */
function configOf(target: SeedFileTarget): ConfigService {
  const values: Record<string, string> = { UPLOAD_DEST: target.uploadsDir, CDN_URL: target.cdnUrl };
  return { get: (key: string, fallback?: string) => values[key] ?? fallback } as ConfigService;
}

export function createSceneSeeder(dataSource: DataSource, target: SeedFileTarget): SceneSeeder {
  const config = configOf(target);
  const files = new SceneFilesService(config);
  const sync = new SceneTemplateSyncProcessor(
    dataSource,
    new SceneLockService(dataSource),
    files,
    new SceneTemplateFilesService(config, files),
  );
  return { dataSource, target, files, sync };
}

async function facesOf(dataSource: DataSource, sceneId: string): Promise<TemplateSceneFace[]> {
  return dataSource.manager.find(TemplateSceneFace, {
    where: { sceneId },
    order: { index: 'ASC' },
  });
}

/** Versão `ready` com master e prévia em disco, apontada como a atual da face (o que o worker deixa ao fim do job). */
async function seedFaceVersion(
  seeder: SceneSeeder,
  scene: TemplateScene,
  face: { index: number },
  art: Buffer,
): Promise<void> {
  const { dataSource, files } = seeder;
  const version = await insertVersion(dataSource, scene.id, {
    number: face.index + 1,
    faceIndex: face.index,
    elements: [],
  });
  const outputs = await buildSceneOutputs(art);
  const assets = [];
  for (const [role, file] of [
    ['master', outputs.master],
    ['preview', outputs.preview],
  ] as const) {
    const written = await files.write(scene.id, version.id, file.filename, file.buffer);
    assets.push(
      await insertAsset(dataSource, version, role, {
        url: written.url,
        width: file.width,
        height: file.height,
        bytes: written.bytes,
      }),
    );
  }
  version.masterAssetId = assets[0].id;
  version.previewAssetId = assets[1].id;
  await dataSource.manager.save(version);
  await pointFace(dataSource, scene, version.id, face.index);
}

async function summarize(dataSource: DataSource, scene: TemplateScene): Promise<SeededScene> {
  const faces = await facesOf(dataSource, scene.id);
  return {
    id: scene.id,
    name: scene.name,
    formatId: scene.formatId,
    layout: scene.layout,
    faces: faces.map((face) => ({
      key: face.key,
      index: face.index,
      versionId: face.currentVersionId as string,
      templateId: face.templateId as string,
    })),
  };
}

const fileExists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

/** A master e a arte do template de cada face existem na pasta e nas URLs de agora (o comando pode mudar de pasta ou de CDN). */
async function filesAreIntact(seeder: SceneSeeder, faces: TemplateSceneFace[]): Promise<boolean> {
  const { dataSource, files, target } = seeder;
  const prefix = `${target.cdnUrl.replace(/\/+$/, '')}/`;
  for (const face of faces) {
    const version = await dataSource.manager.findOneBy(TemplateSceneVersion, {
      id: face.currentVersionId as string,
    });
    const master = await dataSource.manager.findOneBy(TemplateSceneAsset, {
      id: version?.masterAssetId as string,
    });
    const template = await dataSource.manager.findOneBy(Template, {
      id: face.templateId as string,
    });
    const art = (template?.configuration as SceneTemplateConfiguration | undefined)?.bodyBackground
      ?.imageUrl;
    if (!master || !art?.startsWith(prefix)) return false;
    const onDisk = [
      files.absolutePath(master.url),
      path.join(target.uploadsDir, art.slice(prefix.length)),
    ];
    if (!(await Promise.all(onDisk.map(fileExists))).every(Boolean)) return false;
  }
  return true;
}

/**
 * Cena já semeada por completo (toda face com versão, template e arquivos): é reaproveitada, para o comando ser
 * idempotente. Incompleta, com arquivo faltando ou com outro endereço de CDN: é apagada e semeada de novo.
 */
async function findCompleteScene(seeder: SceneSeeder, name: string): Promise<TemplateScene | null> {
  const { dataSource } = seeder;
  const scene = await dataSource.manager.findOneBy(TemplateScene, { name });
  if (!scene) return null;
  const faces = await facesOf(dataSource, scene.id);
  const complete = faces.every((face) => face.currentVersionId && face.templateId);
  if (complete && (await filesAreIntact(seeder, faces))) return scene;
  await deleteTestScenes(dataSource, [scene.id]); // sobra de uma semente que quebrou, ou arquivos que sumiram
  return null;
}

/**
 * Cena com template pronto por face: grava a cena e as faces, uma versão `ready` com arte de teste (cor lisa no tamanho
 * nativo do formato) por face e roda o job de sincronização REAL do worker, que grava os templates com a
 * `configuration` da projeção (A-8). Nome já semeado: devolve a mesma cena.
 */
export async function seedScene(seeder: SceneSeeder, spec: SceneSpec): Promise<SeededScene> {
  const { dataSource } = seeder;
  const existing = await findCompleteScene(seeder, spec.name);
  if (existing) return summarize(dataSource, existing);
  const format = findSceneFormat(spec.formatId) as SceneFormatSpec;
  const size = nativeSizeOfFormat(format);
  const scene = await insertScene(dataSource, {
    name: spec.name,
    formatId: format.id,
    layout: spec.layout,
    artWidthCm: format.artWidthCm,
    artHeightCm: format.artHeightCm,
    widthPx: size.width,
    heightPx: size.height,
    pixelsPerCm: pixelsPerCm(size, format),
  });
  for (const face of facesOfLayout(spec.layout)) {
    const art = await solidPng(size.width, size.height, spec.colors[face.index]);
    await seedFaceVersion(seeder, scene, face, art);
  }
  await seeder.sync.process({ sceneId: scene.id }, 'e2e-seed');
  return summarize(
    dataSource,
    await dataSource.manager.findOneByOrFail(TemplateScene, { id: scene.id }),
  );
}
