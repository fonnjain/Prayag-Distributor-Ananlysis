import { normHead, resolveHeadKey } from "./names.js";
import verifyAnchorsJson from "../../../config/verify_anchors.json";

/**
 * A workbook in the State Heads folder is not automatically a head workbook.
 * Some are copies, slices, or old feeder files that happen to live beside the
 * canonical workbooks. Keep this classification explicit so a folder sum
 * cannot silently become a reconciled master total.
 */
export type StateHeadPackClassification =
  | "canonical-head"
  | "approved-slice"
  | "mixed/non-head feeder"
  | "excluded";

export type StateHeadPackEvidence = {
  headDisplay: string;
  kind: "head" | "nonTerritory" | "unmapped";
  /** Report 1 / register total by fiscal year. */
  byFy: ReadonlyMap<string, { amount: number }>;
};

export type ApprovedStateHeadSlice = {
  /** Canonical heads that the slice is explicitly allowed to contribute to. */
  heads: string[];
  note: string;
};

export type StateHeadPackPolicy = {
  excludeFilenamePatterns: RegExp[];
  approvedSlices: Record<string, ApprovedStateHeadSlice>;
};

export const DEFAULT_STATE_HEAD_PACK_POLICY: StateHeadPackPolicy = {
  // "Copy of ..." is the known FY2025-26 duplicate. The other patterns cover
  // common temporary exports without relying on a particular person's name.
  excludeFilenamePatterns: [
    /^copy\s+of\b/i,
    /\b(?:temp|temporary|backup|duplicate)\b/i,
  ],
  approvedSlices: {},
};

type StateHeadPackConfig = {
  excludeFilenamePatterns?: string[];
  approvedSlices?: Record<string, ApprovedStateHeadSlice>;
};

/**
 * The release policy lives beside the other verification anchors so a
 * deliberate exception is reviewable with the source-of-truth configuration.
 * Invalid patterns are intentionally allowed to throw during startup/check
 * rather than silently broadening the pack.
 */
export function configuredStateHeadPackPolicy(): StateHeadPackPolicy {
  const raw = (verifyAnchorsJson as { state_head_pack?: StateHeadPackConfig })
    .state_head_pack;
  if (!raw) return DEFAULT_STATE_HEAD_PACK_POLICY;
  return {
    excludeFilenamePatterns: (raw.excludeFilenamePatterns ?? []).map(
      (source) => new RegExp(source, "i"),
    ),
    approvedSlices: raw.approvedSlices ?? {},
  };
}

export type StateHeadPackManifestEntry = {
  fileId: string;
  fileName: string;
  classification: StateHeadPackClassification;
  included: boolean;
  reason: string;
  /** Canonical heads evidenced by the workbook's rows. */
  mappedHeads: string[];
  /** All Report 1 totals, including excluded/mixed evidence for the audit. */
  report1ByFy: Record<string, number>;
  /** Only the amount eligible for the released pack. */
  includedByFy: Record<string, number>;
  /** Released amount by canonical head and fiscal year. */
  includedByHeadByFy: Record<string, Record<string, number>>;
};

export type StateHeadPackInput = {
  fileId: string;
  fileName: string;
  evidence: StateHeadPackEvidence[];
  policy?: StateHeadPackPolicy;
};

function cleanFileName(fileName: string): string {
  return fileName
    .replace(/\.(xlsx?|xlsm|csv)$/i, "")
    .replace(/\b(?:fy[\s-]*)?\d{4}[\s-]*\d{2}\b/gi, "")
    .replace(/\b(?:ji|sir)\b/gi, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

function cleanHead(head: string): string {
  return normHead(head);
}

function byFyRecord(
  evidence: StateHeadPackEvidence[],
  included: Set<string>,
): {
  all: Record<string, number>;
  released: Record<string, number>;
  releasedByHead: Record<string, Record<string, number>>;
} {
  const all: Record<string, number> = {};
  const released: Record<string, number> = {};
  const releasedByHead: Record<string, Record<string, number>> = {};
  for (const item of evidence) {
    for (const [fy, value] of item.byFy) {
      all[fy] = (all[fy] ?? 0) + value.amount;
      if (included.has(item.headDisplay)) {
        released[fy] = (released[fy] ?? 0) + value.amount;
        const byHead = (releasedByHead[item.headDisplay] ??= {});
        byHead[fy] = (byHead[fy] ?? 0) + value.amount;
      }
    }
  }
  return { all, released, releasedByHead };
}

function approvedSliceFor(
  input: StateHeadPackInput,
  policy: StateHeadPackPolicy,
): ApprovedStateHeadSlice | null {
  return (
    policy.approvedSlices[input.fileId] ??
    policy.approvedSlices[input.fileName] ??
    null
  );
}

/**
 * Build an auditable manifest entry. This function is pure and deliberately
 * does not read or write Sheets/Drive/DB, which makes the release policy
 * testable against the known duplicate and feeder cases.
 */
export function classifyStateHeadPackFile(
  input: StateHeadPackInput,
): StateHeadPackManifestEntry {
  const policy = input.policy ?? configuredStateHeadPackPolicy();
  const excludedBy = policy.excludeFilenamePatterns.find((re) =>
    re.test(input.fileName),
  );
  const mappedHeads = [
    ...new Set(
      input.evidence
        .filter((item) => item.kind === "head" || item.kind === "unmapped")
        .map((item) => item.headDisplay),
    ),
  ];
  const totals = byFyRecord(input.evidence, new Set());
  const report1ByFy = totals.all;

  if (excludedBy) {
    return {
      fileId: input.fileId,
      fileName: input.fileName,
      classification: "excluded",
      included: false,
      reason:
        `Excluded from the State Head master pack because filename "${input.fileName}" ` +
        `matches temporary/duplicate pattern ${excludedBy.source}.`,
      mappedHeads,
      report1ByFy,
      includedByFy: {},
      includedByHeadByFy: {},
    };
  }

  const approved = approvedSliceFor(input, policy);
  if (approved) {
    const allowed = new Set(approved.heads.map(cleanHead));
    const allHeadsAllowed =
      mappedHeads.length > 0 &&
      mappedHeads.every((head) => allowed.has(cleanHead(head))) &&
      input.evidence
        .filter((item) => item.kind === "nonTerritory")
        .every((item) => item.byFy.size === 0);
    if (allHeadsAllowed) {
      const included = new Set(
        input.evidence
          .filter(
            (item) =>
              (item.kind === "head" || item.kind === "unmapped") &&
              allowed.has(cleanHead(item.headDisplay)),
          )
          .map((item) => item.headDisplay),
      );
      return {
        fileId: input.fileId,
        fileName: input.fileName,
        classification: "approved-slice",
        included: true,
        reason: `Included under explicit approved slice mapping: ${approved.note}`,
        mappedHeads,
        report1ByFy,
        includedByFy: byFyRecord(input.evidence, included).released,
        includedByHeadByFy: byFyRecord(input.evidence, included).releasedByHead,
      };
    }
  }

  const fileKey = cleanFileName(input.fileName);
  const canonicalHeads = [
    ...new Set(
      input.evidence
        .filter((item) => item.kind === "head")
        .map((item) => item.headDisplay),
    ),
  ];
  const isCanonicalNamedFile =
    canonicalHeads.length === 1 &&
    input.evidence.every((item) => item.kind === "head") &&
    (() => {
      const headKey = cleanHead(canonicalHeads[0]);
      const fileResolvedKey = resolveHeadKey(fileKey);
      return (
        fileKey.includes(headKey) ||
        headKey.includes(fileKey) ||
        fileResolvedKey === headKey ||
        // A short folder label such as "LALAN" is an accepted prefix of
        // "Lalan Kumar"; avoid treating very short labels as matches.
        (fileKey.length >= 5 && headKey.startsWith(fileKey))
      );
    })();

  if (isCanonicalNamedFile) {
    const included = new Set(canonicalHeads);
    return {
      fileId: input.fileId,
      fileName: input.fileName,
      classification: "canonical-head",
      included: true,
      reason: `Included as the canonical workbook for ${mappedHeads[0]}.`,
      mappedHeads,
      report1ByFy,
      includedByFy: byFyRecord(input.evidence, included).released,
      includedByHeadByFy: byFyRecord(input.evidence, included).releasedByHead,
    };
  }

  const evidenceKinds = [
    ...new Set(input.evidence.map((item) => item.kind)),
  ].join(", ");
  return {
    fileId: input.fileId,
    fileName: input.fileName,
    classification: "mixed/non-head feeder",
    included: false,
    reason:
      `Not included in a head total: workbook name does not identify one ` +
      `canonical head or contains mixed/non-territory evidence (${evidenceKinds || "none"}). ` +
      "Add an explicit approved slice mapping before including it.",
    mappedHeads,
    report1ByFy,
    includedByFy: {},
    includedByHeadByFy: {},
  };
}

export function manifestWarnings(
  manifest: StateHeadPackManifestEntry[],
): string[] {
  return manifest
    .filter((entry) => entry.classification === "excluded")
    .map((entry) => `${entry.fileName}: ${entry.reason}`);
}

export function manifestBlockers(
  manifest: StateHeadPackManifestEntry[],
): string[] {
  const blockers = manifest
    .filter((entry) => entry.classification === "mixed/non-head feeder")
    .map((entry) => `${entry.fileName}: ${entry.reason}`);
  for (const file of manifestConflictFiles(manifest)) {
    if (file.entries.length < 2) continue;
    if (file.entries.every((entry) => entry.classification === "approved-slice")) {
      continue;
    }
    blockers.push(
      `Duplicate included candidates for ${file.key.replace("|", " FY")}: ` +
        file.entries.map((entry) => entry.fileName).join(", ") +
        ". Keep one canonical source or explicitly resolve the competing files.",
    );
  }
  return blockers;
}

export function manifestConflictFileIds(
  manifest: StateHeadPackManifestEntry[],
): Set<string> {
  const ids = new Set<string>();
  for (const file of manifestConflictFiles(manifest)) {
    if (file.entries.length < 2) continue;
    if (file.entries.every((entry) => entry.classification === "approved-slice")) {
      continue;
    }
    for (const entry of file.entries) ids.add(entry.fileId);
  }
  return ids;
}

function manifestConflictFiles(manifest: StateHeadPackManifestEntry[]): Array<{
  key: string;
  entries: Array<{
    fileId: string;
    fileName: string;
    classification: StateHeadPackClassification;
  }>;
}> {
  const candidates = new Map<
    string,
    Array<{
      fileId: string;
      fileName: string;
      classification: StateHeadPackClassification;
    }>
  >();
  for (const entry of manifest) {
    if (!entry.included) continue;
    for (const [head, byFy] of Object.entries(entry.includedByHeadByFy)) {
      for (const [fy, amount] of Object.entries(byFy)) {
        if (amount === 0) continue;
        const key = `${resolveHeadKey(head)}|${fy}`;
        const list = candidates.get(key) ?? [];
        list.push({
          fileId: entry.fileId,
          fileName: entry.fileName,
          classification: entry.classification,
        });
        candidates.set(key, list);
      }
    }
  }
  return [...candidates.entries()].map(([key, entries]) => ({ key, entries }));
}

export function materialPackDeltaPct(
  packTotal: number,
  sourceTotal: number,
): number {
  return Math.abs(packTotal - sourceTotal) / Math.max(Math.abs(sourceTotal), 1);
}

export function hasMaterialPackTotalDiscrepancy(
  packTotal: number,
  sourceTotal: number,
  threshold = 0.01,
): boolean {
  return materialPackDeltaPct(packTotal, sourceTotal) > threshold;
}

export function missingMaterialSourceHeads(
  packByHead: ReadonlyMap<string, number>,
  sourceByHead: ReadonlyMap<string, number>,
  sourceTotal: number,
  threshold = 0.01,
): Array<{ head: string; net: number; sharePct: number }> {
  return [...sourceByHead.entries()]
    .filter(
      ([head, net]) =>
        !packByHead.has(head) &&
        Math.abs(net) / Math.max(Math.abs(sourceTotal), 1) > threshold,
    )
    .map(([head, net]) => ({
      head,
      net,
      sharePct: Math.abs(net) / Math.max(Math.abs(sourceTotal), 1),
    }));
}

export function stateHeadSourceLoadBlockers(
  folderError: string | null,
  manifest: ReadonlyArray<unknown>,
): string[] {
  const blockers: string[] = [];
  if (folderError) {
    blockers.push(`State Head source could not be loaded: ${folderError}`);
  }
  if (manifest.length === 0) {
    blockers.push(
      "State Head source folder produced no workbook manifest; release is blocked.",
    );
  }
  return blockers;
}

export function fiscalYearsForStateHeadAudit(
  manifest: ReadonlyArray<Pick<StateHeadPackManifestEntry, "report1ByFy">>,
  requestedFy: string | null,
): string[] {
  if (requestedFy) return [requestedFy];
  const fiscalYears = new Set<string>();
  for (const file of manifest) {
    for (const fy of Object.keys(file.report1ByFy)) fiscalYears.add(fy);
  }
  return [...fiscalYears].sort();
}

export type StateHeadSaleSourceRow = {
  head: string | null;
  net: number;
};

/**
 * The State Head pack is a territorial-head scope. Institutional channel
 * sales are a separate company-total scope and must not make a valid
 * territorial pack look unreconciled.
 */
export function isEligibleStateHeadSaleHead(head: string | null): boolean {
  const key = normHead(head ?? "");
  return Boolean(key) && key !== normHead("Non-territory / Project / Govt");
}

export function sumEligibleStateHeadSaleRows(
  rows: StateHeadSaleSourceRow[],
): {
  total: number;
  byHead: Map<string, number>;
  displayByHead: Map<string, string>;
} {
  const byHead = new Map<string, number>();
  const displayByHead = new Map<string, string>();
  let total = 0;
  for (const row of rows) {
    if (!isEligibleStateHeadSaleHead(row.head)) continue;
    const net = Number.isFinite(row.net) ? row.net : 0;
    const display = row.head as string;
    const key = resolveHeadKey(display);
    total += net;
    byHead.set(key, (byHead.get(key) ?? 0) + net);
    displayByHead.set(key, display);
  }
  return { total, byHead, displayByHead };
}
