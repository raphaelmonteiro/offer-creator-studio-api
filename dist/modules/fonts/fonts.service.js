"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FontsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const font_entity_1 = require("./entities/font.entity");
const file_util_1 = require("../../common/utils/file.util");
let FontsService = class FontsService {
    constructor(fontRepository) {
        this.fontRepository = fontRepository;
    }
    async create(createFontDto, fileUrl) {
        const font = this.fontRepository.create({
            ...createFontDto,
            fileUrl,
        });
        return this.fontRepository.save(font);
    }
    async findAll() {
        return this.fontRepository.find({
            order: { createdAt: 'DESC' },
        });
    }
    async findOne(id) {
        const font = await this.fontRepository.findOne({
            where: { id },
        });
        if (!font) {
            throw new common_1.NotFoundException({
                code: 'FONT_NOT_FOUND',
                message: 'Fonte não encontrada',
            });
        }
        return font;
    }
    async remove(id) {
        const font = await this.findOne(id);
        await this.fontRepository.remove(font);
    }
    validateFontFile(filename) {
        if (!(0, file_util_1.isValidFontFile)(filename)) {
            throw new common_1.BadRequestException({
                code: 'INVALID_FONT_FILE',
                message: 'Arquivo deve ser .ttf, .otf, .woff ou .woff2',
            });
        }
    }
};
exports.FontsService = FontsService;
exports.FontsService = FontsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(font_entity_1.Font)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], FontsService);
//# sourceMappingURL=fonts.service.js.map