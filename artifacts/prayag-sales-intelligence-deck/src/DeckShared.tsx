import type { ReactNode } from 'react';

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center ${compact ? 'gap-[.6vw]' : 'gap-[.7vw]'}`}>
      <div className="flex h-[3vw] w-[3vw] items-center justify-center rounded-[.75vw] bg-[#1389e8] font-display text-[2vw] font-bold text-[#f5f2ea] shadow-[0_.7vw_1.7vw_rgba(19,137,232,.2)]">
        P
      </div>
      <div className="leading-none">
        <div className="font-display text-[1.5vw] font-semibold tracking-[-.04em] text-[#f5f2ea]">Prayag India</div>
        <div className="mt-[.35vw] text-[1.5vw] uppercase tracking-[.16em] text-[#8ea2b0]">Sales Intelligence</div>
      </div>
    </div>
  );
}

export function Footer({ number, section }: { number: number; section: string }) {
  return (
    <div className="absolute bottom-[4.5vh] left-[7vw] right-[7vw] flex items-center justify-between footer-rule pt-[1.4vh]">
      <span className="thin-label">{section}</span>
      <span className="font-display text-[1.5vw] font-semibold tracking-[.18em] text-[#6f8493]">{String(number).padStart(2, '0')} / 60</span>
    </div>
  );
}

export function Frame({
  number,
  section,
  children,
  className = '',
  grid = true,
}: {
  number: number;
  section: string;
  children: ReactNode;
  className?: string;
  grid?: boolean;
}) {
  return (
    <div className={`w-screen h-screen overflow-hidden relative deck-frame ${grid ? 'deck-grid' : ''} ${className}`}>
      <div className="absolute left-[7vw] top-[5vh]">
        <BrandMark compact />
      </div>
      {children}
      <Footer number={number} section={section} />
    </div>
  );
}

export function Bullet({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'amber' | 'green' }) {
  const colorClass = tone === 'amber' ? 'bg-[#f3b44b]' : tone === 'green' ? 'bg-[#4ccfa3]' : 'bg-[#58b9f6]';
  return (
    <div className="flex items-start gap-[1vw]">
      <span className={`mt-[.55vw] h-[.7vw] w-[.7vw] shrink-0 rounded-full ${colorClass}`} />
      <p className="body-copy text-[#e4ebef]">{children}</p>
    </div>
  );
}

export function Pill({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'amber' | 'green' | 'red' }) {
  const styles = {
    blue: 'border-[#2b9fea]/40 bg-[#1389e8]/12 text-[#93d1ff]',
    amber: 'border-[#f3b44b]/40 bg-[#f3b44b]/12 text-[#ffd58b]',
    green: 'border-[#4ccfa3]/40 bg-[#4ccfa3]/12 text-[#9be9cf]',
    red: 'border-[#ff6e66]/40 bg-[#ff6e66]/12 text-[#ffaaa3]',
  };
  return <span className={`inline-flex items-center rounded-full border-[.08vw] px-[.9vw] py-[.45vw] text-[1.5vw] font-semibold tracking-[.04em] ${styles[tone]}`}>{children}</span>;
}

export function SectionTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div className="absolute left-[7vw] top-[16vh] max-w-[64vw]">
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="display-head mt-[1.5vh]">{title}</h1>
      {subtitle ? <p className="mt-[2.2vh] max-w-[51vw] body-copy muted">{subtitle}</p> : null}
    </div>
  );
}

export function IndexNumber({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'amber' }) {
  return <div className={`font-display text-[3.3vw] font-semibold tracking-[-.08em] ${tone === 'amber' ? 'text-[#f3b44b]' : 'text-[#58b9f6]'}`}>{children}</div>;
}

export function Rule({ className = '' }: { className?: string }) {
  return <div className={`signal-line ${className}`} />;
}