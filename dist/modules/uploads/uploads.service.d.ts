import { ConfigService } from '@nestjs/config';
export declare class UploadsService {
    private configService;
    private uploadPath;
    constructor(configService: ConfigService);
    private ensureUploadDirectories;
    uploadFile(file: Express.Multer.File, folder?: string): Promise<{
        id: string;
        filename: string;
        url: string;
        mimeType: string;
        size: number;
    }>;
    deleteFile(filePath: string): Promise<void>;
}
