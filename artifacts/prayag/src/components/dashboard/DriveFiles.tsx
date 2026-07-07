import { useCallback, useEffect, useRef, useState } from "react";
import { listDriveFiles, type DriveFile } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Search,
  Loader2,
  AlertCircle,
  ExternalLink,
  Folder,
  FileSpreadsheet,
  FileText,
  Presentation,
  Image as ImageIcon,
  File as FileIcon,
  RefreshCw,
} from "lucide-react";

function fileMeta(mimeType: string) {
  if (mimeType === "application/vnd.google-apps.folder") {
    return { Icon: Folder, tint: "text-amber-500", label: "Folder" };
  }
  if (
    mimeType === "application/vnd.google-apps.spreadsheet" ||
    mimeType.includes("spreadsheetml") ||
    mimeType === "text/csv"
  ) {
    return { Icon: FileSpreadsheet, tint: "text-emerald-600", label: "Spreadsheet" };
  }
  if (
    mimeType === "application/vnd.google-apps.document" ||
    mimeType.includes("wordprocessingml") ||
    mimeType === "application/pdf"
  ) {
    return {
      Icon: FileText,
      tint: mimeType === "application/pdf" ? "text-red-500" : "text-blue-600",
      label: mimeType === "application/pdf" ? "PDF" : "Document",
    };
  }
  if (
    mimeType === "application/vnd.google-apps.presentation" ||
    mimeType.includes("presentationml")
  ) {
    return { Icon: Presentation, tint: "text-orange-500", label: "Presentation" };
  }
  if (mimeType.startsWith("image/")) {
    return { Icon: ImageIcon, tint: "text-purple-500", label: "Image" };
  }
  return { Icon: FileIcon, tint: "text-muted-foreground", label: "File" };
}

function formatSize(size?: string): string | null {
  if (!size) return null;
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function DriveFiles() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  // Guards against out-of-order responses when the query changes rapidly.
  const requestRef = useRef(0);

  const load = useCallback(
    async (q: string, pageToken?: string) => {
      const reqId = ++requestRef.current;
      if (pageToken) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
        setError(false);
      }
      try {
        const params: { q?: string; pageToken?: string } = {};
        if (q) params.q = q;
        if (pageToken) params.pageToken = pageToken;
        const result = await listDriveFiles(Object.keys(params).length ? params : undefined);
        if (reqId !== requestRef.current) return;
        setFiles((prev) => (pageToken ? [...prev, ...result.files] : result.files));
        setNextPageToken(result.nextPageToken);
      } catch {
        if (reqId !== requestRef.current) return;
        if (!pageToken) {
          setFiles([]);
          setNextPageToken(undefined);
        }
        setError(true);
      } finally {
        if (reqId === requestRef.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    load(query);
  }, [query, load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setQuery(input.trim());
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-5">
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-sm">
        <CardContent className="p-4 md:p-5">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h3 className="font-display font-semibold text-lg leading-tight">Google Drive</h3>
              <p className="text-sm text-muted-foreground mt-0.5">
                Browse and open your Drive files and spreadsheets. Files open in a new tab.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => load(query)}
              disabled={isLoading}
              aria-label="Refresh"
              className="shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Search files by name..."
                className="pl-9 bg-background"
              />
            </div>
            <Button type="submit" disabled={isLoading}>
              Search
            </Button>
            {query && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setInput("");
                  setQuery("");
                }}
              >
                Clear
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-sm">
        <CardContent className="p-2 md:p-3">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading your Drive files...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center px-6">
              <AlertCircle className="w-6 h-6 text-destructive" />
              <p className="text-sm text-muted-foreground max-w-sm">
                Could not reach Google Drive. The connection may need to be re-authorized. Please try
                again in a moment.
              </p>
              <Button variant="outline" size="sm" onClick={() => load(query)}>
                Retry
              </Button>
            </div>
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center px-6">
              <Folder className="w-6 h-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {query ? `No files found matching "${query}".` : "No files found in your Drive."}
              </p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-border/50">
                {files.map((file) => {
                  const { Icon, tint, label } = fileMeta(file.mimeType);
                  const size = formatSize(file.size);
                  const modified = formatDate(file.modifiedTime);
                  return (
                    <li key={file.id}>
                      <a
                        href={file.webViewLink ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-muted/60 transition-colors"
                      >
                        <div className="shrink-0">
                          <Icon className={`w-5 h-5 ${tint}`} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{file.name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {label}
                            {modified ? ` \u00b7 Modified ${modified}` : ""}
                            {size ? ` \u00b7 ${size}` : ""}
                          </p>
                        </div>
                        <ExternalLink className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                      </a>
                    </li>
                  );
                })}
              </ul>

              {nextPageToken && (
                <div className="flex justify-center py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => load(query, nextPageToken)}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      "Load more"
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
