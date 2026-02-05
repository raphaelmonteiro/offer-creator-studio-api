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
exports.EmailService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const nodemailer = require("nodemailer");
let EmailService = class EmailService {
    constructor(configService) {
        this.configService = configService;
        this.transporter = nodemailer.createTransport({
            host: this.configService.get('SMTP_HOST', 'smtp.mailtrap.io'),
            port: this.configService.get('SMTP_PORT', 587),
            secure: this.configService.get('SMTP_SECURE', false),
            auth: {
                user: this.configService.get('SMTP_USER'),
                pass: this.configService.get('SMTP_PASS'),
            },
        });
    }
    async sendEmailVerification(email, name, token) {
        const baseUrl = this.configService.get('BASE_URL', 'http://localhost:3003');
        const verificationUrl = `${baseUrl}/v1/auth/verify-email?token=${token}`;
        const mailOptions = {
            from: this.configService.get('MAIL_FROM', '"Encartes" <no-reply@encartes.local>'),
            to: email,
            subject: 'Verifique seu email - Sistema de Encartes',
            html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #dc2626; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9fafb; padding: 30px; }
            .button { display: inline-block; padding: 12px 30px; background-color: #dc2626; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Sistema de Encartes</h1>
            </div>
            <div class="content">
              <h2>Olá, ${name}!</h2>
              <p>Obrigado por se cadastrar no nosso sistema. Para ativar sua conta, clique no botão abaixo para verificar seu email:</p>
              <div style="text-align: center;">
                <a href="${verificationUrl}" class="button">Verificar Email</a>
              </div>
              <p>Ou copie e cole o link abaixo no seu navegador:</p>
              <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
              <p>Este link expira em 24 horas.</p>
              <p>Se você não criou esta conta, ignore este email.</p>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} Sistema de Encartes. Todos os direitos reservados.</p>
            </div>
          </div>
        </body>
        </html>
      `,
        };
        return this.transporter.sendMail(mailOptions);
    }
    async sendPasswordReset(email, name, token) {
        const frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:8080');
        const resetUrl = `${frontendUrl}/auth?token=${token}`;
        const mailOptions = {
            from: this.configService.get('MAIL_FROM', '"Encartes" <no-reply@encartes.local>'),
            to: email,
            subject: 'Redefinição de Senha - Sistema de Encartes',
            html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #dc2626; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9fafb; padding: 30px; }
            .button { display: inline-block; padding: 12px 30px; background-color: #dc2626; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            .warning { background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Sistema de Encartes</h1>
            </div>
            <div class="content">
              <h2>Olá, ${name}!</h2>
              <p>Recebemos uma solicitação para redefinir a senha da sua conta.</p>
              <p>Clique no botão abaixo para criar uma nova senha:</p>
              <div style="text-align: center;">
                <a href="${resetUrl}" class="button">Redefinir Senha</a>
              </div>
              <p>Ou copie e cole o link abaixo no seu navegador:</p>
              <p style="word-break: break-all; color: #666;">${resetUrl}</p>
              <div class="warning">
                <strong>⚠️ Importante:</strong>
                <ul>
                  <li>Este link expira em 1 hora.</li>
                  <li>Se você não solicitou a redefinição de senha, ignore este email.</li>
                  <li>Sua senha atual permanecerá inalterada se você não clicar no link.</li>
                </ul>
              </div>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} Sistema de Encartes. Todos os direitos reservados.</p>
            </div>
          </div>
        </body>
        </html>
      `,
        };
        return this.transporter.sendMail(mailOptions);
    }
};
exports.EmailService = EmailService;
exports.EmailService = EmailService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], EmailService);
//# sourceMappingURL=email.service.js.map