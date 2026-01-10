import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST', 'smtp.mailtrap.io'),
      port: this.configService.get<number>('SMTP_PORT', 587),
      secure: this.configService.get<boolean>('SMTP_SECURE', false), // true for 465, false for other ports
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  async sendEmailVerification(email: string, name: string, token: string) {
    const baseUrl = this.configService.get<string>('BASE_URL', 'http://localhost:3003');
    const verificationUrl = `${baseUrl}/v1/auth/verify-email?token=${token}`;

    const mailOptions = {
      from: this.configService.get<string>('MAIL_FROM', '"Encartes" <no-reply@encartes.local>'),
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

  async sendPasswordReset(email: string, name: string, token: string) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:8080');
    const resetUrl = `${frontendUrl}/auth?token=${token}`;

    const mailOptions = {
      from: this.configService.get<string>('MAIL_FROM', '"Encartes" <no-reply@encartes.local>'),
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
}
