import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide36() {
  return (
    <Frame number={36} section="Product Tour">
      <SectionTitle eyebrow="ALERTS" title="Alerts: Settings" subtitle="Routing rules for notifications." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Role-based alert routing</Bullet>
          <Bullet>Escalation paths for unacknowledged alerts</Bullet>
          <Bullet>Customizable threshold triggers</Bullet>
          <Bullet>Digest frequency controls</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[2vh]">
          <div className="flex items-center justify-between border-b border-[#a9b7c2]/20 pb-[1.5vh]">
             <div className="text-[1.5vw] text-[#e4ebef]">Zero Sales (X Days)</div>
             <div className="h-[2vh] w-[15vw] bg-[#a9b7c2]/20 rounded" />
          </div>
          <div className="flex items-center justify-between border-b border-[#a9b7c2]/20 pb-[1.5vh]">
             <div className="text-[1.5vw] text-[#e4ebef]">Inventory Stock-out</div>
             <div className="h-[2vh] w-[15vw] bg-[#a9b7c2]/20 rounded" />
          </div>
          <div className="flex items-center justify-between border-b border-[#a9b7c2]/20 pb-[1.5vh]">
             <div className="text-[1.5vw] text-[#e4ebef]">Margin Drop &gt; X%</div>
             <div className="h-[2vh] w-[15vw] bg-[#a9b7c2]/20 rounded" />
          </div>
          <div className="flex items-center justify-between pb-[1.5vh]">
             <div className="text-[1.5vw] text-[#e4ebef]">New Customer Acquisition</div>
             <div className="h-[2vh] w-[15vw] bg-[#a9b7c2]/20 rounded" />
          </div>
        </div>
      </div>
    </Frame>
  );
}
