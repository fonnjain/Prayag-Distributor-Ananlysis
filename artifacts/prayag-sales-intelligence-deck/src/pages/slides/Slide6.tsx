import { Frame, Pill, Rule, SectionTitle } from '../../DeckShared';

export default function Slide6() {
  return (
    <Frame number={6} section="05 / THE BUSINESS OVERVIEW">
      <SectionTitle eyebrow="05 / THE BUSINESS OVERVIEW" title="Start with the business overview" />
      <div className="absolute left-[7vw] top-[43vh] w-[27vw]">
        <Rule className="w-[10vw]" />
        <p className="mt-[2.6vh] body-copy text-[#c8d7df]">Overview, Regional, Coverage, Products, and Momentum in one dashboard family</p>
        <div className="mt-[3vh] flex flex-wrap gap-[.65vw]"><Pill>FY</Pill><Pill>PERIOD</Pill><Pill>GEOGRAPHY</Pill><Pill>OWNER</Pill></div>
        <p className="mt-[2.8vh] small-copy">Filter by financial year, period, geography, and sales ownership</p>
      </div>
      <div className="absolute right-[7vw] top-[34vh] w-[50vw] panel p-[1.6vw]">
        <div className="flex items-center justify-between border-b-[.08vw] border-[#a9b7c2]/15 pb-[1.2vw]"><span className="thin-label">OVERVIEW / LIVE SNAPSHOT</span><span className="text-[1.5vw] text-[#4ccfa3]">● SOURCE HEALTHY</span></div>
        <div className="mt-[2vh] grid grid-cols-3 gap-[.8vw]"><div className="panel-soft p-[1vw]"><div className="thin-label">PERFORMANCE</div><div className="mt-[1.6vh] font-display text-[2.2vw] font-semibold">PRIMARY</div><div className="mt-[.8vh] text-[1.5vw] text-[#7ca5bd]">headline view</div></div><div className="panel-soft p-[1vw]"><div className="thin-label">COVERAGE</div><div className="mt-[1.6vh] font-display text-[2.2vw] font-semibold">REACH</div><div className="mt-[.8vh] text-[1.5vw] text-[#7ca5bd]">territory context</div></div><div className="panel-soft p-[1vw]"><div className="thin-label">MOMENTUM</div><div className="mt-[1.6vh] font-display text-[2.2vw] font-semibold">CHANGE</div><div className="mt-[.8vh] text-[1.5vw] text-[#7ca5bd]">direction of travel</div></div></div>
        <div className="mt-[2vh] flex items-end gap-[.6vw]"><div className="h-[8vh] w-[5vw] rounded-t-[.35vw] bg-[#1389e8]/35" /><div className="h-[12vh] w-[5vw] rounded-t-[.35vw] bg-[#1389e8]/50" /><div className="h-[18vh] w-[5vw] rounded-t-[.35vw] bg-[#1389e8]/75" /><div className="h-[14vh] w-[5vw] rounded-t-[.35vw] bg-[#f3b44b]/60" /><div className="h-[22vh] w-[5vw] rounded-t-[.35vw] bg-[#f3b44b]" /><div className="h-[17vh] w-[5vw] rounded-t-[.35vw] bg-[#4ccfa3]/75" /><div className="ml-[1vw] flex-1 pb-[1vh] text-right text-[1.5vw] text-[#8ea2b0]"><div>Period-aware</div><div className="mt-[.5vh]">signal view</div></div></div>
        <div className="mt-[2vh] flex items-center justify-between border-t-[.08vw] border-[#a9b7c2]/15 pt-[1.2vw]"><span className="text-[1.5vw] text-[#8ea2b0]">Keep the headline view connected to the underlying detail</span><Pill tone="amber">LAST GOOD VIEW</Pill></div>
      </div>
    </Frame>
  );
}