import { FontsService } from './fonts.service';
import { UploadsService } from '../uploads/uploads.service';
export declare class FontsController {
    private readonly fontsService;
    private readonly uploadsService;
    constructor(fontsService: FontsService, uploadsService: UploadsService);
    create(file: Express.Multer.File, body: any): Promise<import("./entities/font.entity").Font>;
    findAll(): Promise<import("./entities/font.entity").Font[]>;
    remove(id: string): Promise<{
        message: string;
    }>;
}
