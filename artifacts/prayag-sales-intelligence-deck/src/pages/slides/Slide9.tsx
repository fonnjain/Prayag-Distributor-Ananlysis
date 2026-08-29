import { Bullet, Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide9() {
  return (
    <Frame number={9} section="08 / SKU DEEP DIVE">
      <SectionTitle eyebrow="08 / SKU DEEP DIVE" title="Make SKU breadth actionable" />
      <div className="absolute left-[7vw] top-[40vh] w-[35vw]">
        <div className="panel p-[2vw]">
          <div className="flex items-center justify-between"><span className="thin-label">ITEM SIGNAL / FOCUS</span><Pill tone="amber">GAP → PUSH</Pill></div>
          <div className="mt-[3vh] grid grid-cols-5 gap-[.6vw]">
            <div className="h-[4vw] rounded-[.45vw] bg-[#1389e8]/80" /><div className="h-[4vw] rounded-[.45vw] bg-[#1389e8]/55" /><div className="h-[4vw] rounded-[.45vw] bg-[#f3b44b]/85" /><div className="h-[4vw] rounded-[.45vw] bg-[#4ccfa3]/65" /><div className="h-[4vw] rounded-[.45vw] bg-[#1389e8]/25" />
            <div className="h-[4vw] rounded-[.45vw] bg-[#1389e8]/35" /><div className="h-[4vw] rounded-[.45vw] bg-[#4ccfa3]" /><div className="h-[4vw] rounded-[.45vw] bg-[#1389e8]/20" /><div className="h-[4vw] rounded-[.45vw] bg-[#f3b44b]/40" /><div className="h-[4vw] rounded-[.45vw] bg-[#1389e8]/65" />
          </div>
          <div className="mt-[2vh] flex items-center justify-between"><span className="text-[1.5vw] text-[#91a5b4]">Distributor / direct dealer / retailer / project</span><span className="text-[1.5vw] text-[#ffd58b]">BREADTH</span></div>
        </div>
      </div>
      <div className="absolute right-[7vw] top-[40vh] w-[43vw] space-y-[2vh]">
        <Bullet>Review item facts, quantity, net value, discounts, and movement</Bullet>
        <Bullet>Diagnose gaps across distributor, direct dealer, retailer, and project levels</Bullet>
        <Bullet>Use Trends, Push, Seasonality, Discounts, and Volume Decline together</Bullet>
        <Bullet tone="amber">Turn a gap list into a focused distributor conversation</Bullet>
      </div>
    </Frame>
  );
}