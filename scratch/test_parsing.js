const invoice = {
  invoice_number: 'INV-2026-001',
  issue_date: '2026-04-15',
  due_date: '2026-04-30',
  total_amount: 1500000,
  status: 'sent',
};

const customer = { name: 'John Doe' };
const company = { company_name: 'Antigravity Inc' };
const generatedUrl = 'http://localhost:5173/public/invoice/INV-2026-001';

const formatRupiah = (amount) => {
  return `Rp${new Intl.NumberFormat('id-ID').format(Math.round(amount))}`;
};

const formatDate = (date) => {
  return new Date(date).toLocaleDateString('id-ID', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

const templates = [
  'Halo {customer_name}, invoice {invoice_number} sebesar {total_amount} telah terbit. Silakan cek di {public_invoice_url}. Terima kasih, {company_name}',
  'Tagihan {invoice_number} untuk {customer_name} jatuh tempo pada {due_date}.',
  'Detail: {invoice_number} | {total_amount} | {issue_date} | {due_date}',
  'Variabel salah: {customer} {invoice}',
];

templates.forEach((tpl) => {
  let message = tpl;
  message = message.replace(/{customer_name}/g, customer?.name || 'Bapak/Ibu');
  message = message.replace(/{company_name}/g, company.company_name || 'Kami');
  message = message.replace(/{invoice_number}/g, invoice.invoice_number);
  message = message.replace(/{issue_date}/g, formatDate(invoice.issue_date));
  message = message.replace(/{due_date}/g, formatDate(invoice.due_date));
  message = message.replace(/{total_amount}/g, formatRupiah(invoice.total_amount));
  message = message.replace(/{public_invoice_url}/g, generatedUrl);

  console.log('---');
  console.log('Original:', tpl);
  console.log('Parsed:  ', message);
});
