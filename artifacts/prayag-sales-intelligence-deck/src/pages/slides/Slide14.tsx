import { Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide14() {
  return (
    <Frame number={14} section="13 / TRUST & CONTROL">
      <SectionTitle eyebrow="13 / TRUST & CONTROL" title="Build trust into the workflow" />
      <div className="absolute left-[7vw] top-[42vh] w-[32vw]">
        <div className="font-display text-[3.6vw] font-semibold tracking-[-.07em] text-[#f3b44b]">Trust is a feature.</div>
        <p className="mt-[2.2vh] body-copy muted">The platform keeps the answer useful—and honest—when the data is incomplete or unavailable.</p>
      </div>
      <div className="absolute right-[7vw] top-[37vh] w-[44vw] panel p-[1.8vw]">
        <div className="flex items-center justify-between"><span className="thin-label">CONTROL SURFACE</span><Pill tone="green">AUDITABLE</Pill></div>
        <div className="mt-[2.6vh] space-y-[1.2vw]">
          <div className="flex items-center gap-[1vw]"><div className="flex h-[2.8vw] w-[2.8vw] items-center justify-center rounded-full bg-[#1389e8]/25 text-[1.5vw] text-[#93d1ff]">01</div><div className="text-[1.5vw]">Data Health exposes freshness, lag, and reconciliation checks</div></div>
          <div className="flex items-center gap-[1vw]"><div className="flex h-[2.8vw] w-[2.8vw] items-center justify-center rounded-full bg-[#f3b44b]/25 text-[1.5vw] text-[#ffd58b]">02</div><div className="text-[1.5vw]">Comparison, audit, and cross-foot controls catch drift before decisions do</div></div>
          <div className="flex items-center gap-[1vw]"><div className="flex h-[2.8vw] w-[2.8vw] items-center justify-center rounded-full bg-[#4ccfa3]/25 text-[1.5vw] text-[#9be9cf]">03</div><div className="text-[1.5vw]">Frozen historical periods protect approved baselines</div></div>
          <div className="flex items-center gap-[1vw]"><div className="flex h-[2.8vw] w-[2.8vw] items-center justify-center rounded-full bg-[#ff6e66]/25 text-[1.5vw] text-[#ffaaa3]">04</div><div className="text-[1.5vw]">Unavailable data stays distinct from zero performance</div></div>
        </div>
      </div>
    </Frame>
  );
}