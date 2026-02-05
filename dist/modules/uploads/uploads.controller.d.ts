import { UploadsService } from './uploads.service';
import { UploadDto } from './dto/upload.dto';
export declare class UploadsController {
    private readonly uploadsService;
    constructor(uploadsService: UploadsService);
    uploadFile(file: Express.Multer.File, uploadDto: UploadDto): Promise<{
        id: string;
        filename: string;
        url: string;
        mimeType: string;
        size: number;
    }>;
}
