'use client';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { InvoiceEditor } from '@/components/invoice-editor';
import { PageHeader } from '@/components/ui/layout';
import { useWsId } from '@/lib/hooks';

export default function NewInvoicePage() {
  const ws = useWsId();
  return (
    <>
      <PageHeader
        back={
          <Link href={`/w/${ws}/invoices`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
            <ArrowLeft className="size-4" /> Invoices
          </Link>
        }
        title="New invoice"
        description="Saved as a draft automatically. Submit it to NRS when it's ready."
      />
      <InvoiceEditor />
    </>
  );
}
