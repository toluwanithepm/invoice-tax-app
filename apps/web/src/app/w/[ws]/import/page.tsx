'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label, Select } from '@/components/ui/form';
import { Alert, Card, CardBody, CardHeader, PageHeader, Spinner } from '@/components/ui/layout';
import { api, errorMessage } from '@/lib/api';
import { useWsId } from '@/lib/hooks';

type Kind = 'customers' | 'products';
interface Upload {
  id: string;
  kind: Kind;
  fileName: string;
  headers: string[];
  rowCount: number;
  preview: string[][];
  fields: string[];
  suggestedMapping: Record<string, string>;
}
interface Result {
  total: number;
  valid: number;
  invalid: number;
  errors: { row: number; field: string | null; message: string }[];
  dryRun: boolean;
}
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  kind: 'Type (B2B/B2G)',
  tin: 'Tax ID',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  description: 'Description',
  unitPrice: 'Unit price',
  vatTreatment: 'VAT treatment',
  sku: 'Code / SKU',
};

/** E2-3: CSV/Excel import with column mapping and row-level errors (up to 5,000 rows). */
function Importer() {
  const ws = useWsId();
  const qc = useQueryClient();
  const params = useSearchParams();
  const [kind, setKind] = useState<Kind>((params.get('kind') as Kind) ?? 'customers');
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setError(undefined);
    setResult(null);
    setBusy(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const u = await api.upload<Upload>(`/v1/workspaces/${ws}/imports/${kind}`, fd);
      setUpload(u);
      setMapping(u.suggestedMapping);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function commit(dryRun: boolean) {
    if (!upload) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<Result>(`/v1/workspaces/${ws}/imports/${upload.id}/commit${dryRun ? '?dryRun=true' : ''}`, { mapping });
      setResult(r);
      if (!dryRun) {
        toast.success(`Imported ${r.valid} ${kind}`);
        void qc.invalidateQueries({ queryKey: [kind, ws] });
        setUpload(null);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function downloadTemplate() {
    const t = await api.get<{ fileName: string; csv: string }>(`/v1/import-templates/${kind}`);
    const url = URL.createObjectURL(new Blob([t.csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: t.fileName });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader title="Import from a spreadsheet" description="CSV or Excel (.xlsx), up to 5,000 rows. We check every row before anything is saved." />
      <Card>
        <CardBody className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="kind">What are you importing?</Label>
            <Select
              id="kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as Kind);
                setUpload(null);
                setResult(null);
              }}
              className="w-48"
            >
              <option value="customers">Customers</option>
              <option value="products">Products</option>
            </Select>
          </div>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" id="file" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <Button onClick={() => fileRef.current?.click()} loading={busy && !upload}>
            <FileSpreadsheet /> Choose file
          </Button>
          <Button variant="ghost" onClick={downloadTemplate}>
            <Download /> Download template
          </Button>
        </CardBody>
      </Card>

      {error && (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      )}

      {upload && (
        <Card className="mt-6">
          <CardHeader title={`Match your columns · ${upload.fileName}`} description={`${upload.rowCount.toLocaleString()} rows found`} />
          <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {upload.fields.map((f) => (
              <div key={f}>
                <Label htmlFor={`map-${f}`}>
                  {FIELD_LABELS[f] ?? f}
                  {(f === 'name' || f === 'tin' || f === 'unitPrice' || f === 'vatTreatment') && <span className="text-red-600"> *</span>}
                </Label>
                <Select id={`map-${f}`} value={mapping[f] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value }))}>
                  <option value="">— Not in my file —</option>
                  {upload.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </CardBody>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-subtle">
                  {upload.headers.map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {upload.preview.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => (
                      <td key={j} className="whitespace-nowrap px-3 py-1.5">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
            <Button variant="secondary" onClick={() => commit(true)} loading={busy}>
              Check rows
            </Button>
            <Button onClick={() => commit(false)} loading={busy} disabled={!result?.dryRun || result.valid === 0}>
              Import {result?.dryRun ? `${result.valid} valid rows` : ''}
            </Button>
          </div>
        </Card>
      )}

      {result && (
        <Card className="mt-6">
          <CardHeader
            title={result.dryRun ? 'Check results' : 'Import complete'}
            description={`${result.valid} ready · ${result.invalid} with problems · ${result.total} total`}
          />
          {result.errors.length > 0 ? (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white text-left text-xs uppercase tracking-wide text-subtle">
                  <tr>
                    <th className="px-5 py-2 font-medium">Row</th>
                    <th className="px-3 py-2 font-medium">Column</th>
                    <th className="px-5 py-2 font-medium">Problem</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.errors.map((e, i) => (
                    <tr key={i}>
                      <td className="px-5 py-2">{e.row}</td>
                      <td className="px-3 py-2">{e.field ? (FIELD_LABELS[e.field] ?? e.field) : '—'}</td>
                      <td className="px-5 py-2">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <CardBody>
              <p className="text-sm text-brand-800">Every row looks good.</p>
            </CardBody>
          )}
          {result.dryRun && result.invalid > 0 && <p className="border-t border-line px-5 py-3 text-xs text-subtle">Rows with problems are skipped. Fix them in your file and import again, or continue with the valid rows.</p>}
        </Card>
      )}
    </>
  );
}

export default function ImportPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Importer />
    </Suspense>
  );
}
