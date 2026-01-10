import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { generateFileName, getFileMimeType, isValidImageFile } from '../../common/utils/file.util';
import * as fs from 'fs/promises';

@Injectable()
export class UploadsService {
  private uploadPath: string;

  constructor(private configService: ConfigService) {
    this.uploadPath = this.configService.get<string>('UPLOAD_DEST', './uploads');
    this.ensureUploadDirectories();
  }

  private async ensureUploadDirectories() {
    const folders = ['products', 'logos', 'templates', 'general', 'fonts', 'avatars', 'thumbnails'];
    for (const folder of folders) {
      const folderPath = join(this.uploadPath, folder);
      if (!existsSync(folderPath)) {
        mkdirSync(folderPath, { recursive: true });
      }
    }
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: string = 'general',
  ): Promise<{ id: string; filename: string; url: string; mimeType: string; size: number }> {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'Arquivo é obrigatório',
      });
    }

    const fileName = generateFileName(file.originalname);
    const folderPath = join(this.uploadPath, folder);
    const filePath = join(folderPath, fileName);

    // Ensure folder exists
    if (!existsSync(folderPath)) {
      mkdirSync(folderPath, { recursive: true });
    }

    // Save file
    await fs.writeFile(filePath, file.buffer);

    const baseUrl = this.configService.get<string>('CDN_URL', 'http://localhost:3000/uploads');
    const url = `${baseUrl}/${folder}/${fileName}`;

    return {
      id: fileName,
      filename: file.originalname,
      url,
      mimeType: getFileMimeType(file.originalname),
      size: file.size,
    };
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      const fullPath = join(this.uploadPath, filePath);
      if (existsSync(fullPath)) {
        await fs.unlink(fullPath);
      }
    } catch (error) {
      // Ignore errors on delete
    }
  }
}
