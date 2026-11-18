import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** Uma foto do acervo da Galeria, como o simulado do job a lê. */
export interface GalleryPhoto {
  id: string;
  url: string;
  thumbnailUrl: string | null;
}

/** As primeiras fotos da Galeria por data de criação (só leitura, SQL direto: a Galeria não é do módulo). */
@Injectable()
export class FlyerProGalleryPhotos {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  first(limit: number): Promise<GalleryPhoto[]> {
    return this.dataSource.query(
      `SELECT id, url, "thumbnailUrl" FROM gallery_images ORDER BY "createdAt" ASC, id ASC LIMIT $1`,
      [limit],
    );
  }
}
