import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide43() {
  return (
    <Frame number={43} section="Product Tour">
      <SectionTitle eyebrow="SALES" title="Sales: Deep Dive" subtitle="Granular slice of sales activity." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Multi-dimensional analysis</Bullet>
          <Bullet>Cross-filter by any attribute</Bullet>
          <Bullet>Root-cause investigation</Bullet>
          <Bullet>Exportable custom views</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col relative overflow-hidden">
          <div className="flex gap-[1vw] mb-[2vh]">
            <div className="h-[3vh] w-[15%] border border-[#a9b7c2]/30 rounded-full flex items-center justify-center text-[1.5vw] text-[#a9b7c2]">Filter</div>
            <div className="h-[3vh] w-[15%] border border-[#1389e8]/50 bg-[#1389e8]/10 rounded-full flex items-center justify-center text-[1.5vw] text-[#1389e8]">Zone</div>
            <div className="h-[3vh] w-[15%] border border-[#a9b7c2]/30 rounded-full flex items-center justify-center text-[1.5vw] text-[#a9b7c2]">Product</div>
          </div>
          <div className="flex-1 grid grid-cols-2 relative grid-rows-2 gap-[1vw]">
             <div className="bg-[#a9b7c2]/10 rounded border border-[#a9b7c2]/20" />
             <div className="bg-[#a9b7c2]/10 rounded border border-[#a9b7c2]/20" />
             <div className="bg-[#a9b7c2]/10 rounded border border-[#a9b7c2]/20 col-span-2" />
          </div>
        </div>
      </div>
    </Frame>
  );
}
