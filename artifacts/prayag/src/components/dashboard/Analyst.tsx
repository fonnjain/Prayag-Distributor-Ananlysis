import { useState, useCallback, useEffect, useRef } from "react";
import { useAnalyzeSales } from "@workspace/api-client-react";
import { useGlobalFilter } from "@/data/global-filter-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Send, User, Sparkles, Loader2, AlertCircle, FileDown, ChevronDown, ChevronUp, Mic, MicOff, Calendar, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useVoiceInput } from "@/hooks/useVoiceInput";

// ── Types ─────────────────────────────────────────────────────────────────────

type Message = {
  role: "user" | "assistant" | "system";
  content: string;
};

type GraphIndexLevel = {
  level: string;
  count: number;
  measuresAvailable: string[];
};

type GraphIndexGap = {
  path: string;
  reason: string;
};

type GraphIndex = {
  fy: string;
  fys: string[];
  levels: GraphIndexLevel[];
  gapNodes: GraphIndexGap[];
  generatedAt: string;
};

// ── Suggested questions — exact from document ─────────────────────────────────

const SUGGESTION_GROUPS: { label: string; questions: string[] }[] = [
  {
    label: "Where the business is",
    questions: [
      "Which State Heads are behind their target, and is it coverage or conversion?",
      "Which members carry the most business, and which carry the most risk?",
    ],
  },
  {
    label: "Supply routes",
    questions: [
      "How many retailers cannot order because they have no assigned distributor?",
      "Which members lose the most visits to retailers with no supply route?",
      "Which districts have retailers but no distributor at all?",
    ],
  },
  {
    label: "Effort and return",
    questions: [
      "Where are visits going, and what does each group return?",
      "Which retailers were visited repeatedly and ordered nothing?",
      "What does a visit cost, and which members return most per rupee spent?",
    ],
  },
  {
    label: "The customer base",
    questions: [
      "Is growth new business, or the same customers reordering?",
      "Which accounts bought last year and nothing yet this year?",
    ],
  },
  {
    label: "Concentration",
    questions: [
      "Which distributor carries the most territory risk?",
      "Which members depend on too few customers?",
    ],
  },
  {
    label: "What we cannot answer yet",
    questions: [
      "What questions can this data not answer, and why?",
    ],
  },
];

// ── Build greeting from graph index ──────────────────────────────────────────

function buildGreeting(index: GraphIndex): string {
  const fyList = index.fys.join(", ");
  const reachable = index.levels
    .filter((l) => l.level !== "gap" && l.count > 0)
    .map((l) => `${l.level} (${l.count > 1 ? `${l.count} nodes` : "1 node"})`)
    .join(", ");

  const gapCount = index.gapNodes.length;
  const gapExamples = index.gapNodes
    .slice(0, 2)
    .map((g) => g.path.replace("gap/", "").replace(/-/g, " "))
    .join(", ");

  return (
    `Hello. I am the Prayag India Sales Analyst, wired to the metrics graph for FY${index.fy}.\n\n` +
    `**Fiscal years held:** ${fyList}\n` +
    `**Reachable levels:** ${reachable}\n` +
    `**Known gaps** (${gapCount} total, e.g. ${gapExamples}): I will name the gap and its reason when a question needs one of these — I will not guess.\n\n` +
    `Every number I cite comes from a verified graph node with a source, population note, and data cutoff. What would you like to know?`
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

const API = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

export default function Analyst() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [graphIndex, setGraphIndex] = useState<GraphIndex | null>(null);
  const [cutoffLabel, setCutoffLabel] = useState<string | null>(null);
  // Indices of assistant messages whose answer is currently expanded.
  // The most-recent answer is always auto-expanded; older ones collapse when a new one arrives.
  const [expandedAnswers, setExpandedAnswers] = useState<Set<number>>(new Set());
  const greetingSet = useRef(false);
  const { fy } = useGlobalFilter();

  const analyzeSales = useAnalyzeSales();

  // ── Fetch graph index on mount and when the global FY changes ─────────────

  useEffect(() => {
    const url = `${API}/api/graph/index?fy=${encodeURIComponent(fy)}`;
    fetch(url)
      .then((r) => r.json())
      .then((data: GraphIndex) => {
        setGraphIndex(data);
        setCutoffLabel("Data through Jun 2026 (Jul in progress)");

        if (!greetingSet.current) {
          greetingSet.current = true;
          setMessages([{ role: "assistant", content: buildGreeting(data) }]);
          // Greeting (index 0) starts expanded.
          setExpandedAnswers(new Set([0]));
        }
      })
      .catch(() => {
        if (!greetingSet.current) {
          greetingSet.current = true;
          setMessages([{
            role: "assistant",
            content:
              "Hello. I am the Prayag India Sales Analyst. I answer questions by traversing " +
              "the metrics graph — company, State Head, salesperson, distributor, month. " +
              "Every figure I cite comes from a verified node. What would you like to know?",
          }]);
          setExpandedAnswers(new Set([0]));
        }
      });
  }, [fy]); // eslint-disable-line react-hooks/exhaustive-deps

  const appendTranscript = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev} ${text}` : text));
  }, []);
  const voice = useVoiceInput(appendTranscript);

  const toggleAnswer = (idx: number) => {
    setExpandedAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleSend = (text: string) => {
    if (!text.trim()) return;

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");

    analyzeSales.mutate(
      { data: { question: text } },
      {
        onSuccess: (response) => {
          setMessages((prev) => {
            const next = [...prev, { role: "assistant" as const, content: response.answer }];
            // Auto-expand the new answer; collapse all others except the greeting.
            setExpandedAnswers(new Set([next.length - 1]));
            return next;
          });
        },
        onError: (error) => {
          const msg = (error as { message?: string })?.message ?? String(error);
          setMessages((prev) => [
            ...prev,
            {
              role: "system" as const,
              content: `The analyst could not respond: ${msg}. Please try again.`,
            },
          ]);
        },
      },
    );
  };

  // ── PDF export ────────────────────────────────────────────────────────────

  const exportAnswerPdf = (index: number) => {
    const el = document.getElementById(`analyst-answer-${index}`);
    if (!el) return;

    const question =
      messages
        .slice(0, index)
        .reverse()
        .find((m) => m.role === "user")?.content ?? "";

    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const win = window.open("", "_blank", "width=820,height=920");
    if (!win) return;

    win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Prayag India - Analyst Response</title>
<style>
  body { font-family: 'Inter', system-ui, -apple-system, sans-serif; color: #0f172a; margin: 40px; line-height: 1.6; }
  .brand { color: #1d4ed8; font-weight: 700; font-size: 20px; margin-bottom: 2px; }
  .meta { color: #64748b; font-size: 11px; margin-bottom: 22px; }
  .q { background: #f8fafc; border-left: 3px solid #1d4ed8; padding: 10px 14px; margin: 0 0 20px; font-weight: 600; border-radius: 4px; }
  h1 { font-size: 19px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; font-size: 12px; }
  th { background: #f1f5f9; }
  blockquote { border-left: 3px solid #cbd5e1; margin: 12px 0; padding: 4px 14px; color: #475569; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 10px; }
</style>
</head>
<body>
  <div class="brand">Prayag India - Sales Intelligence</div>
  <div class="meta">AI Analyst response &middot; Generated ${new Date().toLocaleString()}${cutoffLabel ? ` &middot; Data cutoff: ${cutoffLabel}` : ""}</div>
  ${question ? `<div class="q">${escapeHtml(question)}</div>` : ""}
  <div>${el.innerHTML}</div>
  <div class="footer">Generated by the Prayag India Sales Intelligence dashboard. Figures are sourced from verified graph nodes; each cites its data source and population.</div>
</body>
</html>`);
    win.document.close();
    win.focus();
    setTimeout(() => {
      win.print();
    }, 350);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-[calc(100vh-140px)] md:h-[600px] flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Card className="flex-1 flex flex-col overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm shadow-sm">
        <CardHeader className="px-5 py-4 border-b border-border/50 bg-muted/20">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-md bg-primary/10 text-primary">
              <Bot className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-base font-semibold">Ask the Analyst</CardTitle>
              <CardDescription className="text-xs">Graph-traversal AI — every figure cited from a verified node</CardDescription>
            </div>
            {cutoffLabel && (
              <Badge variant="outline" className="text-xs gap-1 font-normal shrink-0">
                <Calendar className="w-3 h-3" />
                {cutoffLabel}
              </Badge>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex-1 p-0 flex flex-col overflow-hidden">
          <div className="p-4 bg-muted/20 border-b border-border/50 space-y-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend(input);
              }}
              className="flex gap-2"
            >
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about sales, distributors, members, visits..."
                className="flex-1 bg-background"
                disabled={analyzeSales.isPending}
              />
              {voice.state !== "unsupported" && (
                <Button
                  type="button"
                  size="icon"
                  variant={voice.state === "listening" ? "destructive" : "outline"}
                  onClick={voice.start}
                  title={voice.state === "listening" ? "Stop listening" : "Speak your question"}
                >
                  {voice.state === "listening" ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </Button>
              )}
              <Button type="submit" size="icon" disabled={analyzeSales.isPending || !input.trim()}>
                <Send className="w-4 h-4" />
                <span className="sr-only">Send</span>
              </Button>
            </form>

            <div>
              <button
                onClick={() => setSuggestionsOpen((o) => !o)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {suggestionsOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {suggestionsOpen ? "Hide suggested questions" : "Show suggested questions"}
              </button>

              {suggestionsOpen && (
                <div className="mt-3 space-y-3 max-h-[34vh] md:max-h-[220px] overflow-y-auto pr-1">
                  {SUGGESTION_GROUPS.map((group) => (
                    <div key={group.label}>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        {group.label}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {group.questions.map((question, i) => (
                          <button
                            key={i}
                            onClick={() => handleSend(question)}
                            disabled={analyzeSales.isPending}
                            className="text-left text-xs px-3 py-1.5 rounded-full bg-background border border-border text-foreground/80 hover:bg-muted hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {question}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <ScrollArea className="flex-1 p-3 md:p-5">
            <div className="space-y-1">
              {/* Loading shimmer while greeting fetches */}
              {messages.length === 0 && (
                <div className="flex gap-2 items-center px-3 py-3 rounded-lg bg-muted/40 border border-border/40">
                  <Sparkles className="w-4 h-4 shrink-0 text-muted-foreground" />
                  <div className="h-3 w-48 bg-muted-foreground/20 rounded animate-pulse" />
                </div>
              )}

              {messages.map((msg, i) => {
                if (msg.role === "user") {
                  // User question — always visible, shown as a compact row
                  return (
                    <div key={i} className="flex items-start gap-2 justify-end pl-8">
                      <p className="text-sm px-4 py-2.5 rounded-2xl rounded-tr-sm bg-primary text-primary-foreground leading-snug">
                        {msg.content}
                      </p>
                      <div className="shrink-0 w-7 h-7 mt-0.5 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                        <User className="w-3.5 h-3.5" />
                      </div>
                    </div>
                  );
                }

                if (msg.role === "system") {
                  return (
                    <div key={i} className="flex gap-2 items-center px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{msg.content}</span>
                    </div>
                  );
                }

                // Assistant answer — collapsible
                const isExpanded = expandedAnswers.has(i);
                // Find the preceding user question for the collapsed label
                const prevQuestion = messages
                  .slice(0, i)
                  .reverse()
                  .find((m) => m.role === "user")?.content ?? null;

                return (
                  <div key={i} className="rounded-xl border border-border/50 bg-muted/40 overflow-hidden">
                    {/* Collapse toggle header */}
                    <button
                      onClick={() => toggleAnswer(i)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/60 transition-colors group"
                    >
                      <div className="shrink-0 w-6 h-6 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center">
                        <Sparkles className="w-3 h-3" />
                      </div>
                      {prevQuestion ? (
                        <span className="flex-1 text-xs font-medium text-foreground/80 truncate">
                          {prevQuestion}
                        </span>
                      ) : (
                        <span className="flex-1 text-xs font-medium text-muted-foreground italic">
                          Introduction
                        </span>
                      )}
                      <ChevronRight
                        className={cn(
                          "w-4 h-4 shrink-0 text-muted-foreground transition-transform duration-200",
                          isExpanded && "rotate-90",
                        )}
                      />
                    </button>

                    {/* Collapsible answer body */}
                    {isExpanded && (
                      <div className="px-4 pb-4 pt-1 border-t border-border/30">
                        <div
                          id={`analyst-answer-${i}`}
                          className="prose prose-sm dark:prose-invert prose-p:leading-relaxed prose-pre:my-0 max-w-none text-foreground"
                        >
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                        {i > 0 && (
                          <button
                            onClick={() => exportAnswerPdf(i)}
                            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-primary transition-colors"
                          >
                            <FileDown className="w-3.5 h-3.5" />
                            Export PDF
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Pending answer skeleton */}
              {analyzeSales.isPending && (
                <div className="rounded-xl border border-border/50 bg-muted/40 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <div className="shrink-0 w-6 h-6 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center">
                      <Sparkles className="w-3 h-3" />
                    </div>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Traversing the graph...</span>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
