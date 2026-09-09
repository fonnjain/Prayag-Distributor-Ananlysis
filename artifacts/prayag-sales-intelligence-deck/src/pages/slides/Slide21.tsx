import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide21() {
  return (
    <Frame number={21} section="Product Tour">
      <SectionTitle eyebrow="DASHBOARD" title="Dashboard: Overview" subtitle="The executive summary of performance." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Headline metrics at a glance</Bullet>
          <Bullet>YTD vs prior year comparisons</Bullet>
          <Bullet>Primary and secondary dispatch numbers</Bullet>
          <Bullet>Immediate operational health indicators</Bullet>
        </div>
        <div className="flex-1 grid grid-cols-2 relative gap-[1.5vw]">
          <div className="panel p-[1.5vw] flex flex-col justify-center relative">
             <div className="thin-label">PRIMARY DISPATCH</div>
             <div className="display text-[2.5vw] mt-[1vh] text-[#f5f2ea]">₹ XX.X Cr</div>
             <div className="text-[1.5vw] text-[#4ccfa3] mt-[1vh]">+XX% vs LY</div>
          </div>
          <div className="panel p-[1.5vw] flex flex-col justify-center relative">
             <div className="thin-label">SECONDARY SALES</div>
             <div className="display text-[2.5vw] mt-[1vh] text-[#f5f2ea]">₹ XX.X Cr</div>
             <div className="text-[1.5vw] text-[#4ccfa3] mt-[1vh]">+XX% vs LY</div>
          </div>
          <div className="panel p-[1.5vw] flex flex-col justify-center relative">
             <div className="thin-label">ACTIVE OUTLETS</div>
             <div className="display text-[2.5vw] mt-[1vh] text-[#f5f2ea]">XX,XXX</div>
             <div className="text-[1.5vw] text-[#f3b44b] mt-[1vh]">-X% vs LY</div>
          </div>
          <div className="panel p-[1.5vw] flex flex-col justify-center relative">
             <div className="thin-label">PENDING ORDERS</div>
             <div className="display text-[2.5vw] mt-[1vh] text-[#f5f2ea]">₹ X.X Cr</div>
             <div className="text-[1.5vw] text-[#a9b7c2] mt-[1vh]">Current Pipeline</div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
