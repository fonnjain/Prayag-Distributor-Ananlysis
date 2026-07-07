import { useState } from "react";
import { useAnalyzeSales } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Send, User, Sparkles, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Message = {
  role: "user" | "assistant" | "system";
  content: string;
};

const SUGGESTION_GROUPS: { label: string; questions: string[] }[] = [
  {
    label: "Start here",
    questions: [
      "What are the 3 highest-impact moves to grow sales this quarter, based on the data?",
    ],
  },
  {
    label: "Where sales come from",
    questions: [
      "Which State Heads and states are driving sales, and which are underperforming relative to their partner base?",
      "Show the top and bottom 5 states by sales — what's different about them?",
    ],
  },
  {
    label: "Resources deployed",
    questions: [
      "Rank State Heads by sales per partner — where is the biggest productivity gap to close?",
      "We have 604 distributors and 169 dealers across 11 heads — which territories are over- or under-resourced for the sales they produce?",
    ],
  },
  {
    label: "Coverage",
    questions: [
      "Where is coverage thin, and which states or districts should we expand into next?",
      "How much of our 31-state, 378-district footprint actually produces sales, and where are the whitespace gaps?",
    ],
  },
  {
    label: "Most-sold items",
    questions: [
      "What are our top-selling items and categories by value?",
      "Which categories earn the most after cost (gross margin), not just revenue?",
      "How is the product mix shifting from FY24-25 to the FY26-27 order book?",
    ],
  },
  {
    label: "Momentum",
    questions: [
      "Where is order-book demand growing fastest, and are we resourced to capture it?",
    ],
  },
];

export default function Analyst() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: "Hello! I'm your AI sales analyst. I have access to all your Prayag India FY24-25 sales data, FY26-27 pipeline, and coverage metrics. What would you like to know?"
    }
  ]);
  const [input, setInput] = useState("");

  const analyzeSales = useAnalyzeSales();

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    
    setMessages(prev => [...prev, { role: "user", content: text }]);
    setInput("");
    
    analyzeSales.mutate({ data: { question: text } }, {
      onSuccess: (response) => {
        setMessages(prev => [...prev, { role: "assistant", content: response.answer }]);
      },
      onError: (error) => {
        setMessages(prev => [...prev, { 
          role: "system", 
          content: "Sorry, I encountered an error while analyzing the data. Please try again." 
        }]);
      }
    });
  };

  return (
    <div className="h-[calc(100vh-140px)] md:h-[600px] flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Card className="flex-1 flex flex-col overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm shadow-sm">
        <CardHeader className="px-5 py-4 border-b border-border/50 bg-muted/20">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-md bg-primary/10 text-primary">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-base font-semibold">Ask the Analyst</CardTitle>
              <CardDescription className="text-xs">AI-powered insights grounded in your dataset</CardDescription>
            </div>
          </div>
        </CardHeader>
        
        <CardContent className="flex-1 p-0 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1 p-4 md:p-6">
            <div className="space-y-6">
              {messages.map((msg, i) => (
                <div 
                  key={i} 
                  className={cn(
                    "flex gap-3 max-w-[85%]",
                    msg.role === "user" ? "ml-auto flex-row-reverse" : ""
                  )}
                >
                  <div className={cn(
                    "flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
                    msg.role === "user" ? "bg-primary text-primary-foreground" : 
                    msg.role === "assistant" ? "bg-secondary text-secondary-foreground" : "bg-destructive/10 text-destructive"
                  )}>
                    {msg.role === "user" ? <User className="w-4 h-4" /> : 
                     msg.role === "assistant" ? <Sparkles className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                  </div>
                  <div className={cn(
                    "px-4 py-3 rounded-2xl text-sm leading-relaxed",
                    msg.role === "user" ? "bg-primary text-primary-foreground rounded-tr-sm" : 
                    msg.role === "assistant" ? "bg-muted text-foreground rounded-tl-sm border border-border/50" : "bg-destructive/10 text-destructive rounded-tl-sm border border-destructive/20"
                  )}>
                    {msg.role === "user" || msg.role === "system" ? (
                      <p>{msg.content}</p>
                    ) : (
                      <div className="prose prose-sm dark:prose-invert prose-p:leading-relaxed prose-pre:my-0 max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {analyzeSales.isPending && (
                <div className="flex gap-3 max-w-[85%]">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div className="px-4 py-4 rounded-2xl bg-muted rounded-tl-sm border border-border/50 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Analyzing data...</span>
                  </div>
                </div>
              )}

              {messages.length === 1 && !analyzeSales.isPending && (
                <div className="pt-2 space-y-5">
                  <p className="text-sm text-muted-foreground">Pick a question to get started, or type your own below.</p>
                  {SUGGESTION_GROUPS.map((group) => (
                    <div key={group.label}>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        {group.label}
                      </p>
                      <div className="flex flex-col gap-2">
                        {group.questions.map((question, i) => (
                          <button
                            key={i}
                            onClick={() => handleSend(question)}
                            className="text-left text-sm px-3.5 py-2.5 rounded-lg bg-background border border-border text-foreground/80 hover:bg-muted hover:text-foreground hover:border-primary/40 transition-colors"
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
          </ScrollArea>
          
          <div className="p-4 bg-muted/20 border-t border-border/50">
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
                placeholder="Ask about sales, regions, or products..."
                className="flex-1 bg-background"
                disabled={analyzeSales.isPending}
              />
              <Button type="submit" size="icon" disabled={analyzeSales.isPending || !input.trim()}>
                <Send className="w-4 h-4" />
                <span className="sr-only">Send</span>
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
