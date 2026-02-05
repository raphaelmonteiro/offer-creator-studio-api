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
exports.CreateCollaboratorDto = exports.CollaboratorStatus = exports.CollaboratorRole = void 0;
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
var CollaboratorRole;
(function (CollaboratorRole) {
    CollaboratorRole["COLLABORATOR"] = "collaborator";
    CollaboratorRole["MANAGER"] = "manager";
    CollaboratorRole["ADMIN"] = "admin";
})(CollaboratorRole || (exports.CollaboratorRole = CollaboratorRole = {}));
var CollaboratorStatus;
(function (CollaboratorStatus) {
    CollaboratorStatus["ACTIVE"] = "active";
    CollaboratorStatus["INACTIVE"] = "inactive";
})(CollaboratorStatus || (exports.CollaboratorStatus = CollaboratorStatus = {}));
class CreateCollaboratorDto {
}
exports.CreateCollaboratorDto = CreateCollaboratorDto;
__decorate([
    (0, swagger_1.ApiProperty)({ example: 'Carlos Santos' }),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCollaboratorDto.prototype, "name", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ example: 'carlos@empresa.com' }),
    (0, class_validator_1.IsEmail)(),
    __metadata("design:type", String)
], CreateCollaboratorDto.prototype, "email", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ example: '(11) 97777-7777', required: false }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCollaboratorDto.prototype, "phone", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ enum: CollaboratorRole, default: CollaboratorRole.COLLABORATOR }),
    (0, class_validator_1.IsEnum)(CollaboratorRole),
    __metadata("design:type", String)
], CreateCollaboratorDto.prototype, "role", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ example: 'senha123' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(6),
    __metadata("design:type", String)
], CreateCollaboratorDto.prototype, "password", void 0);
//# sourceMappingURL=create-collaborator.dto.js.map