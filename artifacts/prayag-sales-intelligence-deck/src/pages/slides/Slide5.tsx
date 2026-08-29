import { Bullet, Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide5() {
  return (
    <Frame number={5} section="04 / THE DATA FOUNDATION">
      <SectionTitle eyebrow="04 / THE DATA FOUNDATION" title="A connected data foundation" />
      <div className="absolute left-[7vw] top-[42vh] w-[35vw] space-y-[2vh]">
        <Bullet>Live and historical sales registers</Bullet>
        <Bullet>Primary sales and order-booking data</Bullet>
        <Bullet>Target masters, rosters, and organization ownership</Bullet>
        <Bullet>Customer, distributor, catalogue, MRP, margin, and competition data</Bullet>
        <Bullet tone="amber">Data Health makes freshness and reconciliation visible</Bullet>
      </div>
      <div className="absolute right-[7vw] top-[34vh] w-[43vw]">
        <div className="panel p-[2vw]">
          <div className="flex items-center justify-between"><span className="thin-label">SOURCE LAYERS</span><Pill tone="green">TRACEABLE</Pill></div>
          <div className="mt-[2.8vh] space-y-[1vw]">
            <div className="flex items-center gap-[1vw]"><div className="h-[5vh] w-[5vh] rounded-[.7vw] bg-[#1389e8]/20 ring-[.08vw] ring-[#1389e8]/50" /><div className="flex-1"><div className="font-display text-[1.55vw] font-semibold">Registers & primary sales</div><div className="small-copy">Observed business activity</div></div><span className="text-[1.5vw] text-[#6ec5ff]">01</span></div>
            <div className="ml-[2.5vw] h-[.12vw] bg-[#284e68]" />
            <div className="flex items-center gap-[1vw]"><div className="h-[5vh] w-[5vh] rounded-[.7vw] bg-[#f3b44b]/20 ring-[.08vw] ring-[#f3b44b]/50" /><div className="flex-1"><div className="font-display text-[1.55vw] font-semibold">Targets & ownership</div><div className="small-copy">Who owns the plan</div></div><span className="text-[1.5vw] text-[#ffd58b]">02</span></div>
            <div className="ml-[2.5vw] h-[.12vw] bg-[#284e68]" />
            <div className="flex items-center gap-[1vw]"><div className="h-[5vh] w-[5vh] rounded-[.7vw] bg-[#4ccfa3]/20 ring-[.08vw] ring-[#4ccfa3]/50" /><div className="flex-1"><div className="font-display text-[1.55vw] font-semibold">Master data & context</div><div className="small-copy">What makes the signal usable</div></div><span className="text-[1.5vw] text-[#9be9cf]">03</span></div>
          </div>
        </div>
      </div>
    </Frame>
  );
}