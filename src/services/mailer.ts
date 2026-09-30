import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config.ts';

export interface MailMessage {
    to: string;
    subject: string;
    text: string; 
}

export type SendMail = (message: MailMessage) => Promise<void>;

let transporter: Transporter | null = null;

export const sendMail: SendMail = async ({ to, subject, text }) => {
    if (!config.mail.smtpUrl){
        throw new Error('SMTP URL is not configured');
    }
    transporter ??= nodemailer.createTransport(config.mail.smtpUrl);
    await transporter.sendMail({
        from: config.mail.from,
        to,
        subject,
        text,
    });
}
