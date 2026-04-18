/**
 * Calculates total and tax amounts for an invoice based on its items and display preferences.
 * @param {Array} items - The invoice items.
 * @param {Object} preferences - Display preferences (show_discount, show_tax).
 * @returns {Object} - An object containing totalAmount and taxAmount.
 */
export function calculateInvoiceTotals(items = [], preferences = {}) {
  const { show_discount = false, show_tax = false } = preferences;
  let totalAmount = 0;
  let taxAmount = 0;

  for (const item of items) {
    const quantity = parseFloat(item.quantity) || 0;
    const unitPrice = parseFloat(item.unit_price) || 0;
    const lineTotal = quantity * unitPrice;

    // Apply discount only if show_discount is true
    const discountPercent = parseFloat(item.discount) || 0;
    const discountAmount = show_discount ? lineTotal * (discountPercent / 100) : 0;
    
    const subtotal = lineTotal - discountAmount;
    
    // Apply tax only if show_tax is true
    const taxRate = parseFloat(item.tax_rate) || 0;
    const lineTax = show_tax ? subtotal * (taxRate / 100) : 0;
    
    totalAmount += subtotal;
    taxAmount += lineTax;
  }

  return { totalAmount, taxAmount };
}
