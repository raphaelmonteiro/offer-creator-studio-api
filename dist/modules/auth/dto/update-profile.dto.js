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
exports.UpdateProfileDto = void 0;
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
class EstablishmentDto {
}
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, example: 'Supermercado Bom Preço' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], EstablishmentDto.prototype, "tradeName", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, example: 'Supermercado Bom Preço LTDA' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], EstablishmentDto.prototype, "companyName", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, example: 'Rua das Flores, 123' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], EstablishmentDto.prototype, "address", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, example: 'São Paulo' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], EstablishmentDto.prototype, "city", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, example: 'SP' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], EstablishmentDto.prototype, "state", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, example: '01234-567' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], EstablishmentDto.prototype, "zipCode", void 0);
class UpdateProfileDto {
}
exports.UpdateProfileDto = UpdateProfileDto;
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, example: 'João Silva' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "name", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, example: '(11) 99999-9999' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "phone", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, example: '123.456.789-00' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "cpfCnpj", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, nullable: true, example: 'https://cdn.exemplo.com/avatars/user.jpg' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateProfileDto.prototype, "avatarUrl", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ type: EstablishmentDto, required: false }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    (0, class_validator_1.ValidateNested)(),
    (0, class_transformer_1.Type)(() => EstablishmentDto),
    __metadata("design:type", EstablishmentDto)
], UpdateProfileDto.prototype, "establishment", void 0);
//# sourceMappingURL=update-profile.dto.js.map