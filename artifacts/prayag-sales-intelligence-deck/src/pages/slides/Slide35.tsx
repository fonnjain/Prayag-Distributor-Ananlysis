import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide35() {
  return (
    <Frame number={35} section="Product Tour">
      <SectionTitle eyebrow="ALERTS" title="Alerts: Red Alerts" subtitle="Critical operational warnings." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Immediate notification of severe drops</Bullet>
          <Bullet>Inventory stock-out warnings</Bullet>
          <Bullet>High-value customer churn signals</Bullet>
          <Bullet>Directly mapped to responsible owner</Bullet>
        </div>
        <div className="flex-1 flex flex-col gap-[2vh]">
            <div className="panel border border-[#ff6e66]/40 bg-[#ff6e66]/5 p-[1.5vw] flex items-start gap-[1.5vw]">
              <div className="mt-[.5vh] w-[1vw] h-[1vw] rounded-full bg-[#ff6e66] shadow-[0_0_1vw_#ff6e66]" />
              <div>
                 <div className="text-[1.5vw] text-[#f5f2ea]">Zero Secondary Sales (X Days)</div>
                 <div className="text-[1.5vw] text-[#ffaaa3] mt-[.5vh]">Distributor: North-West Logistics</div>
                 <div className="text-[1.5vw] text-[#a9b7c2] mt-[1vh]">Assigned to: Regional Manager</div>
              </div>
            </div>
            <div className="panel border border-[#ff6e66]/40 bg-[#ff6e66]/5 p-[1.5vw] flex items-start gap-[1.5vw]">
              <div className="mt-[.5vh] w-[1vw] h-[1vw] rounded-full bg-[#ff6e66] shadow-[0_0_1vw_#ff6e66]" />
              <div>
                 <div className="text-[1.5vw] text-[#f5f2ea]">Inventory Stock-out</div>
                 <div className="text-[1.5vw] text-[#ffaaa3] mt-[.5vh]">Category: Premium Fixtures</div>
                 <div className="text-[1.5vw] text-[#a9b7c2] mt-[1vh]">Assigned to: Supply Chain Head</div>
              </div>
            </div>
        </div>
      </div>
    </Frame>
  );
}
