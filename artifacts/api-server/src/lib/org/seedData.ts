// Seed data for DS1 — Organisation / State Heads.
// All names, aliases, member counts, and flags are CONFIRMED BY THE BUSINESS.
// Source: STATE HEAD DASHBOARD 2026-27 (1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM),
// tab 'Data', header row 3.
//
// ── IDENTITY RULE (from Prayag_Identity_Rule_and_Sandeep_REVISED.docx) ──────
// Two records are the SAME person only if ALL of these hold:
//   1. Names match after normalisation, OR confirmed business alias
//   2. Same State Head, OR documented transfer with effective date
//   3. Same state, OR documented territory move with effective date
//   4. Compatible headquarter
//
// ANY ONE of the following DISPROVES a match — no override:
//   • Co-existence: they appear as separate rows in the same tab for the same
//     period (nobody is their own colleague — this alone settled Ashutosh Kumar)
//   • Different State Head in the same fiscal year
//   • Different state in the same fiscal year
//   • Different headquarter in the same fiscal year
//
// Similarity may only SUGGEST a match and always requires human confirmation.
// Geography DISPROVES outright. Never auto-merge on name similarity.
// ────────────────────────────────────────────────────────────────────────────

export type SeedHead = {
  id: string;
  displayName: string;
  status: "active" | "left" | "inactive";
  memberCount: number;
  hq?: string;
  isDualRole?: boolean;
  dualRoleDetail?: string;
  sheetRowRef?: string;
  aliases?: Array<{ alias: string; fySeen: string | null }>;
};

export type SeedFlag = {
  headId: string | null;
  flagType: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail: Record<string, unknown>;
};

export const SEED_HEADS: SeedHead[] = [
  {
    id: "sandeep-dadheech",
    displayName: "Sandeep Dadheech",
    status: "active",
    memberCount: 74,
    aliases: [{ alias: "Sandeep Ji", fySeen: "2025-26" }],
  },
  {
    id: "syed-aqil-rizvi",
    displayName: "Syed Aqil Rizvi",
    status: "active",
    memberCount: 32,
    // 'AQIL RIZVI' is used in the Secondary Order Booking Report tab (tab-specific,
    // not FY-specific). Confirmed same person; short form only appears in that tab.
    aliases: [{ alias: "AQIL RIZVI", fySeen: null }],
  },
  {
    id: "lalan-kumar",
    displayName: "Lalan Kumar",
    status: "active",
    memberCount: 15,
    aliases: [],
  },
  {
    id: "anant-singh",
    displayName: "Anant Singh",
    status: "active",
    memberCount: 13,
    aliases: [],
  },
  {
    id: "biju-co",
    displayName: "Biju C.O",
    status: "active",
    memberCount: 12,
    // Secondary Order Booking Report carries BOTH 'BIJU C.O' (16 rows) and
    // 'Biju CO' (1 row) in the same tab. Co-existence test does not fire because
    // they share the same State Head row — safe to alias. Both confirmed.
    aliases: [
      { alias: "BIJU C.O", fySeen: null },
      { alias: "Biju CO", fySeen: null },
    ],
  },
  {
    id: "pawan-sharma",
    displayName: "Pawan Sharma",
    status: "active",
    memberCount: 11,
    aliases: [{ alias: "Pawan Kumar Sharma", fySeen: null }],
  },
  {
    id: "sunil-patel",
    displayName: "Sunil Patel",
    status: "active",
    memberCount: 5,
    aliases: [],
  },
  {
    id: "nasir-hussain-khan",
    displayName: "Nasir Hussain Khan",
    status: "active",
    memberCount: 5,
    aliases: [],
  },
  {
    id: "sulinder-pal",
    displayName: "Sulinder Pal",
    status: "active",
    memberCount: 5,
    aliases: [{ alias: "Sulindar Pal", fySeen: null }],
  },
  {
    id: "prashant-onam-naik",
    displayName: "Prashant Onam Naik",
    status: "active",
    memberCount: 5,
    isDualRole: true,
    dualRoleDetail:
      "Row 153: appears as MEMBER with blank State Head (col A empty) — an orphan member row — while also being a State Head on rows 154, 160, 162, 171, 179. The org model supports both roles. Flagged for human confirmation; do not auto-correct.",
    sheetRowRef: "row_153",
    aliases: [],
  },
  {
    id: "sunil-mohanty",
    displayName: "Sunil Mohanty",
    status: "active",
    memberCount: 3,
    aliases: [],
  },
  {
    id: "anuj-sharma",
    displayName: "Anuj Sharma",
    status: "active",
    memberCount: 2,
    isDualRole: true,
    dualRoleDetail:
      "Row 178: listed as a MEMBER under Sunil Mohanty, and also a State Head with two members of his own. Both roles are valid. Flagged for human confirmation; do not auto-correct.",
    sheetRowRef: "row_178",
    aliases: [],
  },
  // Leaver — confirmed LEFT, preserved with history.
  {
    id: "suresh-kumar-nair",
    displayName: "Suresh Kumar Nair",
    status: "left",
    memberCount: 0,
    aliases: [{ alias: "Suresh Nair", fySeen: null }],
  },
];

export const SEED_FLAGS: SeedFlag[] = [
  {
    headId: "suresh-kumar-nair",
    flagType: "leaver_with_orphans",
    severity: "warning",
    title: "Leaver — 8 customers need reassignment",
    detail: {
      customerCount: 8,
      description:
        "Suresh Kumar Nair has left the company. 8 customers remain attributed to him in sale_line.head_canon. These require reassignment to an active State Head — see DS3 for the leaver flow.",
    },
  },
  {
    headId: null,
    flagType: "non_territory",
    severity: "warning",
    title: "Non-territory / Project / Govt — 164 customers, ₹6.08 Cr unresolved",
    detail: {
      customerCount: 164,
      revenueInr: 60800000,
      percentOfTotal: 35,
      description:
        "Not a person. 35% of the FY2026-27 customer population (₹6.08 Cr). Value in sale_line.head_canon. Requires a business decision on attribution — not a code fix. Do not delete or hide; must remain visible in all company totals.",
    },
  },
  {
    headId: "prashant-onam-naik",
    flagType: "dual_role",
    severity: "info",
    title: "Dual-role: State Head who also appears as an orphan member (row 153)",
    detail: {
      sheetRow: 153,
      description:
        "In the Data tab, row 153 has col A (State Head) blank while col C (Name) is 'Prashant Onam Naik'. He also appears as State Head on rows 154, 160, 162, 171, 179. Neither role has been auto-corrected. Confirm with the business whether row 153 should be removed or assigned to a parent head.",
    },
  },
  {
    headId: "anuj-sharma",
    flagType: "dual_role",
    severity: "info",
    title: "Dual-role: State Head who is also listed as a member under Sunil Mohanty (row 178)",
    detail: {
      sheetRow: 178,
      parentHead: "Sunil Mohanty",
      description:
        "Row 178 lists Anuj Sharma as a MEMBER under Sunil Mohanty. He is also a State Head with two members on other rows. Both roles are preserved. Confirm whether the member row is intentional (own territory) or a data entry error.",
    },
  },
  // ── Flags from HR roster analysis (Aug 2026) ─────────────────────────────
  {
    headId: "sunil-mohanty",
    flagType: "unresolved_head_canon",
    severity: "warning",
    title: "[Unresolved] byHead entry — 'Narendra Sharma' (90 sale_line rows, FY2026-27)",
    detail: {
      headCanonValue: "Narendra Sharma",
      rowCount: 90,
      bookingLakhs: 42.2,
      saleLakhs: 5.5,
      description:
        "90 sale_line rows carry head_canon = 'Narendra Sharma'. Narendra Sharma is a member under Sunil Mohanty, not a State Head. These rows produce an '[Unresolved]' entry in byHead (₹42.2L booking / ₹5.5L sale). Pending business confirmation to re-attribute head_canon to 'Sunil Mohanty' in the DB.",
    },
  },
  {
    headId: "prashant-onam-naik",
    flagType: "hierarchy_contradiction",
    severity: "warning",
    title: "HR file contradicts dashboard — reports to Biju C.O, not a peer State Head",
    detail: {
      employeeCode: "45896996663",
      reportingManager: "Biju C.O",
      designation: "State Head-Sales",
      directReports: 5,
      description:
        "In the HR roster file, Prashant Onam Naik (Emp #45896996663, designation 'State Head-Sales') has Biju C.O as Reporting Manager and 5 active direct reports of his own. The dashboard treats him as a peer State Head. Business must confirm: (a) keep as a sub-head under Biju, (b) demote to member, or (c) retain as a peer State Head with the HR file updated.",
    },
  },
  {
    headId: null,
    flagType: "member_hr_deactive",
    severity: "warning",
    title: "3 active dashboard members are deactive in HR",
    detail: {
      members: [
        { name: "SANOJ M.", empCode: "25896696" },
        { name: "Shafeeq Parengal", empCode: "65895896" },
        { name: "Vishant Bandhral", empCode: "1007" },
      ],
      description:
        "These 3 members appear as active (isLeft=false) in the State Head Dashboard but are marked deactive in the HR file. If they have left the company, their rows and any attributed figures should be reviewed for reassignment to active heads.",
    },
  },
  {
    headId: null,
    flagType: "member_no_hr_record",
    severity: "warning",
    title: "5 active dashboard members have no HR record",
    detail: {
      members: [
        "Anuj Sharma",
        "Brinder Singh",
        "Himanshu Sharma",
        "Narendra Kumar Sharma",
        "Ram Kumar Vashishtha",
      ],
      description:
        "These 5 members appear as active in the State Head Dashboard but have no record anywhere in the HR file — not active, not deactive, simply absent. Source of truth unclear; may be pre-system hires or data entry gaps. Do not use these rows for cost or CTC analysis until confirmed.",
    },
  },
];
