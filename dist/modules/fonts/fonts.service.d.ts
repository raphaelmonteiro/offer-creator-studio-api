import { Repository } from 'typeorm';
import { Font } from './entities/font.entity';
import { CreateFontDto } from './dto/create-font.dto';
export declare class FontsService {
    private fontRepository;
    constructor(fontRepository: Repository<Font>);
    create(createFontDto: CreateFontDto, fileUrl: string): Promise<Font>;
    findAll(): Promise<Font[]>;
    findOne(id: string): Promise<Font>;
    remove(id: string): Promise<void>;
    validateFontFile(filename: string): void;
}
