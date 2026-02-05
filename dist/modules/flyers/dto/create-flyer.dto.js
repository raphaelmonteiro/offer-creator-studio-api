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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateFlyerDto = void 0;
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
class CreateFlyerDto {
}
exports.CreateFlyerDto = CreateFlyerDto;
__decorate([
    (0, swagger_1.ApiProperty)({ example: 'Ofertas de Janeiro' }),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateFlyerDto.prototype, "name", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, nullable: true }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], CreateFlyerDto.prototype, "clientId", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ type: 'object' }),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateFlyerDto.prototype, "configuration", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({
        required: false,
        enum: ['auto', 'custom'],
        default: 'auto',
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsIn)(['auto', 'custom']),
    __metadata("design:type", String)
], CreateFlyerDto.prototype, "layout", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({
        required: false,
        nullable: true,
        description: 'Configuração do grid quando layout = "custom"',
        type: 'object',
    }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateFlyerDto.prototype, "customGridConfig", void 0);
//# sourceMappingURL=create-flyer.dto.js.map