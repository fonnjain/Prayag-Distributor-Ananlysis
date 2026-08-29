import { Bullet, Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide10() {
  return (
    <Frame number={10} section="09 / TARGETS & COVERAGE">
      <SectionTitle eyebrow="09 / TARGETS & COVERAGE" title="Plan with targets and coverage" />
      <div className="absolute left-[7vw] top-[42vh] w-[30vw] space-y-[2vh]">
        <Bullet>Compare targets, bookings, sales, and achievement</Bullet>
        <Bullet>See where planned coverage differs from observed activity</Bullet>
        <Bullet tone="amber">Use member and territory views to focus coaching</Bullet>
        <Bullet>Keep ownership, plans, and actuals in the same operating context</Bullet>
      </div>
      <div className="absolute right-[7vw] top-[38vh] w-[46vw]">
        <div className="panel p-[2vw]">
          <div className="flex items-center justify-between"><span className="thin-label">PLAN → OBSERVE → COACH</span><Pill tone="green">ALIGNED CONTEXT</Pill></div>
          <div className="mt-[3vh] flex items-center gap-[1vw]">
            <div className="flex-1"><div className="thin-label">TARGET</div><div className="mt-[1vh] h-[5vh] w-full rounded-[.4vw] bg-[#1389e8]/65" /></div>
            <div className="text-[1.7vw] text-[#7ca5bd]">→</div>
            <div className="flex-1"><div className="thin-label">BOOKING</div><div className="mt-[1vh] h-[5vh] w-[78%] rounded-[.4vw] bg-[#f3b44b]/80" /></div>
            <div className="text-[1.7vw] text-[#7ca5bd]">→</div>
            <div className="flex-1"><div className="thin-label">SALES</div><div className="mt-[1vh] h-[5vh] w-[61%] rounded-[.4vw] bg-[#4ccfa3]/75" /></div>
          </div>
          <div className="mt-[3vh] grid grid-cols-3 gap-[.8vw]"><div className="panel-soft p-[1vw]"><div className="thin-label">OWNER</div><div className="mt-[1.2vh] text-[1.5vw] text-[#dce8ee]">Member</div></div><div className="panel-soft p-[1vw]"><div className="thin-label">SCOPE</div><div className="mt-[1.2vh] text-[1.5vw] text-[#dce8ee]">Territory</div></div><div className="panel-soft p-[1vw]"><div className="thin-label">NEXT</div><div className="mt-[1.2vh] text-[1.5vw] text-[#ffd58b]">Coach</div></div></div>
        </div>
      </div>
    </Frame>
  );
}