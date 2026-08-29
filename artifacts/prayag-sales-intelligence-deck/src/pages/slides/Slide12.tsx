import { Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide12() {
  return (
    <Frame number={12} section="11 / AI REPORTING">
      <SectionTitle eyebrow="11 / AI REPORTING" title="Ask better questions with AI" />
      <div className="absolute left-[7vw] top-[41vh] w-[30vw] space-y-[2vh]">
        <div className="flex gap-[1.2vw]"><div className="mt-[.55vw] h-[.7vw] w-[.7vw] rounded-full bg-[#58b9f6]" /><p className="body-copy">AI Analyst helps investigate business questions</p></div>
        <div className="flex gap-[1.2vw]"><div className="mt-[.55vw] h-[.7vw] w-[.7vw] rounded-full bg-[#58b9f6]" /><p className="body-copy">AI Reports turn scoped data into manager-ready narratives</p></div>
        <div className="flex gap-[1.2vw]"><div className="mt-[.55vw] h-[.7vw] w-[.7vw] rounded-full bg-[#f3b44b]" /><p className="body-copy">Reports preserve period, geography, and ownership context</p></div>
        <div className="flex gap-[1.2vw]"><div className="mt-[.55vw] h-[.7vw] w-[.7vw] rounded-full bg-[#4ccfa3]" /><p className="body-copy">Human-readable explanations sit beside the underlying metrics</p></div>
      </div>
      <div className="absolute right-[7vw] top-[35vh] w-[46vw] panel p-[1.7vw]">
        <div className="flex items-center justify-between border-b-[.08vw] border-[#a9b7c2]/15 pb-[1.3vw]"><span className="thin-label">AI REPORT / SCOPED CONTEXT</span><Pill tone="green">EXPLAINED</Pill></div>
        <div className="mt-[2vh] flex gap-[1vw]"><div className="flex h-[3vw] w-[3vw] items-center justify-center rounded-full bg-[#1389e8]/25 font-display text-[1.5vw] text-[#93d1ff]">Q</div><div className="panel-soft flex-1 p-[1.1vw] text-[1.5vw] text-[#dbe7ed]">What changed in this period, and where should the manager look next?</div></div>
        <div className="mt-[1.5vh] flex gap-[1vw]"><div className="flex h-[3vw] w-[3vw] items-center justify-center rounded-full bg-[#f3b44b]/25 font-display text-[1.5vw] text-[#ffd58b]">A</div><div className="panel flex-1 p-[1.1vw]"><div className="text-[1.5vw] leading-[1.3] text-[#dbe7ed]">The narrative stays inside the selected period, geography, and ownership scope.</div><div className="mt-[1.3vh] flex gap-[.7vw]"><Pill>PERIOD</Pill><Pill>OWNER</Pill><Pill tone="amber">NEXT REVIEW</Pill></div></div></div>
      </div>
    </Frame>
  );
}