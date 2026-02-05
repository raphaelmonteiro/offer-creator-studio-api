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
exports.CreateTemplateDto = exports.TemplateType = void 0;
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
var TemplateType;
(function (TemplateType) {
    TemplateType["HEADER"] = "header";
    TemplateType["FOOTER"] = "footer";
    TemplateType["FULL"] = "full";
})(TemplateType || (exports.TemplateType = TemplateType = {}));
class CreateTemplateDto {
}
exports.CreateTemplateDto = CreateTemplateDto;
__decorate([
    (0, swagger_1.ApiProperty)({ example: 'Header Clássico Vermelho' }),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateTemplateDto.prototype, "name", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: TemplateType, example: TemplateType.HEADER }),
    (0, class_validator_1.IsEnum)(TemplateType),
    __metadata("design:type", String)
], CreateTemplateDto.prototype, "type", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ type: 'object' }),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateTemplateDto.prototype, "configuration", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ required: false, default: false }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], CreateTemplateDto.prototype, "isDefault", void 0);
//# sourceMappingURL=create-template.dto.js.map