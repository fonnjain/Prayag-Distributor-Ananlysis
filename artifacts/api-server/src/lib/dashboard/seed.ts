// Loads the bundled static dataset. Parts of the dashboard are not present in
// the two live Google Sheets we can read (distributor/dealer rosters, district
// and city coverage), so those are carried over from this seed. The seed is
// also used to bootstrap the very first snapshot before any live sync runs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DashboardManifest {
  generated: string;
  [key: string]: unknown;
}

export interface SeedDataset {
  data: Record<string, unknown>;
  manifest: DashboardManifest;
}

function loadSeed(): SeedDataset {
  const candidates = [
    join(__dirname, "../../../data/prayag_data.json"),
    join(process.cwd(), "data/prayag_data.json"),
    join(process.cwd(), "artifacts/api-server/data/prayag_data.json"),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as SeedDataset;
    } catch {
      // try next candidate
    }
  }
  throw new Error("prayag_data.json seed dataset not found");
}

export const seed: SeedDataset = loadSeed();
