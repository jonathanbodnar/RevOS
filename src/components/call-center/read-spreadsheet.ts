/**
 * Open a lead file in the browser. The file itself never leaves the page:
 * the import flow sends only normalized rows to the server.
 *
 * Excel files are read with read-excel-file (MIT), loaded only when an .xlsx
 * file is picked so the page doesn't carry it otherwise.
 */
import {
  decodeText,
  detectFileKind,
  ImportFileError,
  MAX_FILE_BYTES,
  sheetsFromCsv,
  type FileKind,
  type Grid,
  type Sheet,
} from "@/lib/call-center/import";

export async function readSpreadsheetFile(file: File): Promise<{ kind: FileKind; sheets: Sheet[] }> {
  if (file.size > MAX_FILE_BYTES) {
    throw new ImportFileError("This file is over 20 MB. Split it into smaller files and upload them one at a time.");
  }
  if (file.size === 0) throw new ImportFileError("This file is empty.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detectFileKind(file.name, bytes.subarray(0, 4));
  if (kind === "csv") return { kind, sheets: sheetsFromCsv(decodeText(bytes)) };

  const { default: readXlsxFile } = await import("read-excel-file/browser");
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    // Numbers come back as their exact text, so long ids and phone numbers
    // stored as numbers don't lose digits. Date cells still come back as Dates.
    sheets = (await readXlsxFile<string>(bytes.buffer as ArrayBuffer, { parseNumber: (s: string) => s })) as {
      sheet: string;
      data: unknown[][];
    }[];
  } catch {
    throw new ImportFileError("This Excel file couldn't be read. Open it in Excel, save it again as .xlsx or CSV, and try again.");
  }
  const out = sheets
    .map((s) => ({ name: s.sheet, rows: s.data as Grid }))
    .filter((s) => s.rows.some((r) => r.some((c) => c !== null && c !== undefined && c !== "")));
  if (!out.length) throw new ImportFileError("This workbook has no filled-in sheets.");
  return { kind, sheets: out };
}
