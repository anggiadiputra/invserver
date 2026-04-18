import pool from '../src/db/pool.js';

const templates = {
  wa_invoice_template: `Yth. Bapak/Ibu {customer_name},

Berikut adalah tagihan (Invoice) terbaru Anda dari {company_name}.
Nomor Invoice: {invoice_number}
Total Tagihan: {total_amount}
Jatuh Tempo: {due_date}

Silakan klik tautan di bawah ini untuk melihat detail invoice dan melakukan pembayaran:
{public_invoice_url}

Terima kasih atas kerja sama Anda yang baik.

Salam,
{company_name}`,

  wa_paid_template: `Yth. Bapak/Ibu {customer_name},

Terima kasih! Pembayaran untuk Invoice {invoice_number} sebesar {total_amount} telah kami terima dengan baik.

Anda dapat melihat detail tanda terima pembayaran Anda di tautan berikut:
{public_invoice_url}

Senang bisa bekerja sama dengan Anda.

Salam,
{company_name}`,

  wa_reminder_template: `Halo {customer_name},

Sekadar mengingatkan bahwa Invoice {invoice_number} sebesar {total_amount} akan/telah jatuh tempo pada {due_date}.

Mohon segera lakukan pembayaran melalui tautan berikut agar layanan tetap berjalan lancar:
{public_invoice_url}

Abaikan pesan ini jika Anda sudah melakukan pembayaran. Terima kasih.

Salam,
{company_name}`
};

async function restoreTemplates() {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE email = $1', ['anggiadiputra@gmail.com']);
    if (userRes.rows.length === 0) {
      console.error('User not found');
      return;
    }
    const userId = userRes.rows[0].id;

    await pool.query(
      `UPDATE company_settings 
       SET wa_invoice_template = $1, 
           wa_paid_template = $2, 
           wa_reminder_template = $3 
       WHERE user_id = $4`,
      [templates.wa_invoice_template, templates.wa_paid_template, templates.wa_reminder_template, userId]
    );

    console.log('✅ Templates restored successfully for', userId);
  } catch (err) {
    console.error('❌ Error restoring templates:', err);
  } finally {
    process.exit();
  }
}

restoreTemplates();
