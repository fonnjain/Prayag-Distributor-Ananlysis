import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide41() {
  return (
    <Frame number={41} section="Product Tour">
      <SectionTitle eyebrow="SALES" title="Sales: Secondary Performance" subtitle="Distributor to retailer sales." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>True market demand visibility</Bullet>
          <Bullet>Retailer off-take velocity</Bullet>
          <Bullet>Primary vs Secondary gap analysis</Bullet>
          <Bullet>Channel inventory build-up alerts</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex gap-[2vw]">
          <div className="flex-1 flex flex-col justify-center items-center">
            <div className="text-[3vw] text-[#1389e8] font-display">₹ XX.X Cr</div>
            <div className="text-[1.5vw] text-[#a9b7c2]">Primary Dispatch</div>
          </div>
          <div className="flex items-center">
            <div className="w-[4vw] h-[.2vw] bg-[#a9b7c2]/30" />
            <div className="w-[1vw] h-[1vw] border-t-[.2vw] border-r-[.2vw] border-[#a9b7c2]/30 rotate-45 -ml-[.6vw]" />
          </div>
          <div className="flex-1 flex flex-col justify-center items-center">
            <div className="text-[3vw] text-[#f3b44b] font-display">₹ XX.X Cr</div>
            <div className="text-[1.5vw] text-[#a9b7c2]">Secondary Sales</div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
