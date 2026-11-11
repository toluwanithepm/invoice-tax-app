import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { DOC_TYPE_LABELS, VAT_LABELS, type DocType, type VatTreatment } from '@einv/shared';
import { decrypt } from '../common/crypto';
import { invoiceDto } from '../invoices/invoice.mapper';

type InvoiceView = ReturnType<typeof invoiceDto>;
export interface SellerView {
  name: string;
  tradingName?: string | null;
  tin: string | null;
  address: string | null;
  email?: string | null;
  phone?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountEnc?: string | null;
  invoiceTerms?: string | null;
  brandColor?: string | null;
}

// Built-in PDF fonts have no ₦ glyph, so amounts use the ISO code.
const money = (n: number) => 'NGN ' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** E3-4: printable invoice with IRN and QR stamp once cleared; drafts are watermarked. */
@Injectable()
export class PdfService {
  async render(inv: InvoiceView, seller: SellerView, logo: { data: Buffer } | null): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${DOC_TYPE_LABELS[inv.docType as DocType]} ${inv.number ?? 'draft'}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    const accent = seller.brandColor ?? '#14532d';
    const left = 48;
    const right = doc.page.width - 48;

    // Header
    let y = 48;
    if (logo) {
      try {
        doc.image(logo.data, left, y, { fit: [120, 60] });
      } catch {
        /* unsupported image: skip */
      }
    }
    doc.fillColor(accent).fontSize(20).font('Helvetica-Bold').text(DOC_TYPE_LABELS[inv.docType as DocType].toUpperCase(), left, y, { width: right - left, align: 'right' });
    doc.fillColor('#111').fontSize(10).font('Helvetica');
    doc.text(inv.number ? `No. ${inv.number}` : 'Draft', { align: 'right' });
    doc.text(`Issue date: ${inv.issueDate}`, { align: 'right' });
    if (inv.dueDate) doc.text(`Due date: ${inv.dueDate}`, { align: 'right' });
    if (inv.originalInvoice) doc.text(`Against invoice ${inv.originalInvoice.number} (IRN ${inv.originalInvoice.irn})`, { align: 'right' });

    // Parties
    y = 140;
    const col = (right - left) / 2;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555').text('FROM', left, y).text('BILL TO', left + col, y);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(seller.tradingName ?? seller.name, left, y + 14, { width: col - 12 });
    const buyer = (inv.buyer ?? inv.customer ?? {}) as { name?: string; tin?: string; address?: string; email?: string };
    doc.text(buyer.name ?? '—', left + col, y + 14, { width: col - 12 });
    doc.font('Helvetica').fontSize(9);
    doc.text([seller.tradingName ? seller.name : null, `TIN ${seller.tin ?? '—'}`, seller.address, seller.email, seller.phone].filter(Boolean).join('\n'), left, y + 30, { width: col - 12 });
    doc.text([`TIN ${buyer.tin ?? '—'}`, buyer.address, buyer.email].filter(Boolean).join('\n'), left + col, y + 30, { width: col - 12 });

    // Lines
    y = 250;
    const cols = [
      // A4 content width is ~499pt; amounts need room for "NGN 9,999,999.99" on one line.
      { h: 'Description', w: 140, a: 'left' as const },
      { h: 'Qty', w: 35, a: 'right' as const },
      { h: 'Unit price', w: 85, a: 'right' as const },
      { h: 'Discount', w: 75, a: 'right' as const },
      { h: 'VAT', w: 55, a: 'right' as const },
      { h: 'Amount', w: right - left - 390, a: 'right' as const },
    ];
    const row = (cells: string[], yy: number, bold = false) => {
      let x = left;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      cells.forEach((c, i) => {
        doc.text(c, x, yy, { width: cols[i]!.w - 4, align: cols[i]!.a });
        x += cols[i]!.w;
      });
    };
    doc.rect(left, y - 4, right - left, 18).fill('#f1f5f9');
    doc.fillColor('#111');
    row(cols.map((c) => c.h), y, true);
    y += 20;
    for (const l of inv.lines) {
      const vatLabel = VAT_LABELS[l.vatTreatment as VatTreatment] ?? l.vatTreatment;
      row([l.description, String(l.quantity), money(l.unitPrice), l.discount ? money(l.discount) : '—', vatLabel.replace(/ \(.*\)/, ''), money(l.net)], y);
      y = Math.max(doc.y, y + 14) + 4;
      if (y > doc.page.height - 220) {
        doc.addPage();
        y = 60;
      }
    }

    // Totals
    y += 8;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#e2e8f0').stroke();
    y += 8;
    const tot = (label: string, value: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5);
      doc.text(label, right - 240, y, { width: 120, align: 'right' });
      doc.text(value, right - 115, y, { width: 115, align: 'right' });
      y += bold ? 18 : 14;
    };
    tot('Subtotal', money(inv.subtotal));
    if (inv.discountTotal) tot('Discounts', '-' + money(inv.discountTotal));
    tot('VAT', money(inv.vatTotal));
    tot('Total', money(inv.total), true);

    // Payment, terms, notes
    const bank = seller.bankAccountEnc ? decrypt(seller.bankAccountEnc) : null;
    let infoY = y + 10;
    doc.font('Helvetica').fontSize(9).fillColor('#111');
    if (seller.bankName || bank) {
      doc.font('Helvetica-Bold').text('Pay to', left, infoY);
      doc.font('Helvetica').text([seller.bankName, bank, seller.bankAccountName].filter(Boolean).join(' · '), left, infoY + 12, { width: 300 });
      infoY = doc.y + 10;
    }
    if (inv.reason) {
      doc.font('Helvetica-Bold').text('Reason', left, infoY);
      doc.font('Helvetica').text(inv.reason, left, infoY + 12, { width: 300 });
      infoY = doc.y + 10;
    }
    if (inv.notes) {
      doc.font('Helvetica-Bold').text('Notes', left, infoY);
      doc.font('Helvetica').text(inv.notes, left, infoY + 12, { width: 300 });
      infoY = doc.y + 10;
    }
    if (seller.invoiceTerms) {
      doc.font('Helvetica-Bold').text('Terms', left, infoY);
      doc.font('Helvetica').fontSize(8).text(seller.invoiceTerms, left, infoY + 12, { width: 300 });
    }

    // IRN + QR stamp, or draft watermark
    if (inv.status === 'cleared' && inv.irn && inv.qrPayload) {
      const qr = await QRCode.toBuffer(inv.qrPayload, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
      const qy = y + 10;
      doc.image(qr, right - 110, qy, { width: 110 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(accent).text('CLEARED BY NRS', right - 300, qy + 10, { width: 185, align: 'right' });
      doc.font('Helvetica').fillColor('#111').text(`IRN ${inv.irn}`, right - 300, qy + 24, { width: 185, align: 'right', lineBreak: false });
      if (inv.clearedAt) doc.text(`Cleared ${inv.clearedAt.slice(0, 16).replace('T', ' ')} UTC`, right - 300, qy + 36, { width: 185, align: 'right' });
    } else {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Helvetica-Bold').fontSize(48).fillColor('#ef4444').opacity(0.15);
      doc.text('DRAFT — NOT VALID FOR TAX', 0, doc.page.height / 2 - 30, { width: doc.page.width, align: 'center' });
      doc.restore();
    }

    doc.end();
    return done;
  }
}
