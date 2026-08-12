// Google Drive access via the Replit "google-drive" connector integration.
// The connector proxy injects the OAuth token and handles refresh automatically.
// Do not cache the client — tokens expire.
import { ReplitConnectors } from "@replit/connectors-sdk";

export type DriveApiFile = {
  id: string;
  name: string;
  mimeType: string;
  iconLink?: string;
  webViewLink?: string;
  modifiedTime?: string;
  size?: string;
};

export type DriveFileListResult = {
  files: DriveApiFile[];
  nextPageToken?: string;
};

export async function listDriveFiles(opts: {
  q?: string;
  pageToken?: string;
}): Promise<DriveFileListResult> {
  const connectors = new ReplitConnectors();

  const clauses = ["trashed = false"];
  const search = opts.q?.trim();
  if (search) {
    const escaped = search.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    clauses.push(`name contains '${escaped}'`);
  }

  const params = new URLSearchParams();
  params.set("q", clauses.join(" and "));
  params.set("pageSize", "50");
  params.set("orderBy", "folder,modifiedTime desc");
  params.set("spaces", "drive");
  params.set(
    "fields",
    "nextPageToken, files(id, name, mimeType, iconLink, webViewLink, modifiedTime, size)",
  );
  params.set("supportsAllDrives", "true");
  params.set("includeItemsFromAllDrives", "true");
  if (opts.pageToken) {
    params.set("pageToken", opts.pageToken);
  }

  const response = await connectors.proxy(
    "google-drive",
    `/drive/v3/files?${params.toString()}`,
    { method: "GET" },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google Drive API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    files?: DriveApiFile[];
    nextPageToken?: string;
  };

  return {
    files: data.files ?? [],
    nextPageToken: data.nextPageToken,
  };
}

// ── List all children of a Drive folder (files + subfolders). ─────────────
// Paginates automatically; returns up to 1 000 items.
export async function listDriveFolder(folderId: string): Promise<DriveApiFile[]> {
  const connectors = new ReplitConnectors();
  const all: DriveApiFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams();
    params.set("q", `'${folderId}' in parents and trashed = false`);
    params.set("pageSize", "200");
    params.set(
      "fields",
      "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
    );
    params.set("supportsAllDrives", "true");
    params.set("includeItemsFromAllDrives", "true");
    if (pageToken) params.set("pageToken", pageToken);

    const response = await connectors.proxy(
      "google-drive",
      `/drive/v3/files?${params.toString()}`,
      { method: "GET" },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Drive folder list error ${response.status}: ${body}`);
    }
    const data = (await response.json()) as {
      files?: DriveApiFile[];
      nextPageToken?: string;
    };
    all.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return all;
}

// ── Download the raw bytes of a non-native Drive file (e.g. xlsx). ────────
export async function downloadDriveFileBuffer(fileId: string): Promise<Buffer> {
  const connectors = new ReplitConnectors();
  const response = await connectors.proxy(
    "google-drive",
    `/drive/v3/files/${fileId}?alt=media`,
    { method: "GET" },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Drive download error ${response.status}: ${body}`);
  }
  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
}

// ── Search for folders whose name contains a given string. ────────────────
export async function findDriveFoldersByName(
  nameContains: string,
): Promise<DriveApiFile[]> {
  const connectors = new ReplitConnectors();
  const escaped = nameContains.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const params = new URLSearchParams();
  params.set(
    "q",
    `name contains '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  params.set("pageSize", "20");
  params.set("fields", "files(id, name, mimeType)");
  params.set("supportsAllDrives", "true");
  params.set("includeItemsFromAllDrives", "true");

  const response = await connectors.proxy(
    "google-drive",
    `/drive/v3/files?${params.toString()}`,
    { method: "GET" },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Drive folder search error ${response.status}: ${body}`);
  }
  const data = (await response.json()) as { files?: DriveApiFile[] };
  return data.files ?? [];
}
