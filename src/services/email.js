import nodemailer from 'nodemailer';

class EmailService {
  /**
   * Send email using custom SMTP settings
   * @param {object} settings - SMTP settings from company_settings
   * @param {object} options - Email options (to, subject, text, html)
   * @returns {Promise<object>} Result of sending email
   */
  async sendEmail(settings, options) {
    const {
      smtp_host,
      smtp_port,
      smtp_user,
      smtp_pass,
      smtp_from_email,
      smtp_from_name,
      smtp_encryption,
    } = settings;

    // Configure transporter
    let secure = false;
    let tls = {};

    if (smtp_encryption === 'ssl') {
      secure = true;
    } else if (smtp_encryption === 'tls') {
      secure = false;
      tls = { rejectUnauthorized: false };
    } else if (smtp_encryption === 'none') {
      secure = false;
      tls = { rejectUnauthorized: false };
    }

    const transporter = nodemailer.createTransport({
      host: smtp_host,
      port: parseInt(smtp_port, 10),
      secure: secure,
      auth: {
        user: smtp_user,
        pass: smtp_pass,
      },
      tls: tls,
      connectionTimeout: 10000,
    });

    const from = smtp_from_name ? `"${smtp_from_name}" <${smtp_from_email}>` : smtp_from_email;

    try {
      const info = await transporter.sendMail({
        from: from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });

      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error) {
      console.error('Email send error:', error);
      throw error;
    }
  }
}

export default new EmailService();
