import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide24() {
  return (
    <Frame number={24} section="Product Tour">
      <SectionTitle eyebrow="DASHBOARD" title="Dashboard: Products" subtitle="Category and SKU performance trends." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Top moving categories</Bullet>
          <Bullet>SKU level dispatch vs secondary</Bullet>
          <Bullet>Identify slow-moving inventory</Bullet>
          <Bullet>Category contribution to total sales</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[1vh]">
           <div className="flex border-b border-[#a9b7c2]/30 pb-[1vh] mb-[1vh] text-[1.5vw] text-[#a9b7c2]">
             <div className="flex-[2]">Category</div>
             <div className="flex-1">Revenue</div>
             <div className="flex-1">Volume</div>
             <div className="flex-1">Trend</div>
           </div>
           <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
             <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#1389e8]/30 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#4ccfa3]/40 rounded mr-[2vw]" />
           </div>
           <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
             <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#1389e8]/30 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#4ccfa3]/40 rounded mr-[2vw]" />
           </div>
           <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
             <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#1389e8]/30 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#4ccfa3]/40 rounded mr-[2vw]" />
           </div>
           <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
             <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#1389e8]/30 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#4ccfa3]/40 rounded mr-[2vw]" />
           </div>
           <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
             <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#1389e8]/30 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
             <div className="flex-1 h-[1.5vh] bg-[#4ccfa3]/40 rounded mr-[2vw]" />
           </div>
        </div>
      </div>
    </Frame>
  );
}
