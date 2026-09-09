import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide33() {
  return (
    <Frame number={33} section="Product Tour">
      <SectionTitle eyebrow="EXECUTION" title="Execution: Pending Orders" subtitle="Visibility into the unfulfilled pipeline." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Track open order backlogs</Bullet>
          <Bullet>Identify supply chain bottlenecks</Bullet>
          <Bullet>Aged order highlighting</Bullet>
          <Bullet>Clear line-of-sight to dispatch</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[1.5vh]">
           <div className="flex border-b border-[#a9b7c2]/30 pb-[1vh] mb-[1vh] text-[1.5vw] text-[#a9b7c2]">
             <div className="flex-[2]">Order ID</div>
             <div className="flex-1">Value</div>
             <div className="flex-1">Age</div>
             <div className="flex-1">Status</div>
           </div>
             <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">XX Days</div>
               <div className="flex-1 flex items-center gap-[.5vw]">
                 <div className="w-[.8vw] h-[.8vw] rounded-full bg-[#ff6e66]" />
                 <span className="text-[1.5vw] text-[#e4ebef]">Critical</span>
               </div>
             </div>
             <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">XX Days</div>
               <div className="flex-1 flex items-center gap-[.5vw]">
                 <div className="w-[.8vw] h-[.8vw] rounded-full bg-[#f3b44b]" />
                 <span className="text-[1.5vw] text-[#e4ebef]">Warning</span>
               </div>
             </div>
             <div className="flex items-center py-[1vh] border-b border-[#a9b7c2]/10">
               <div className="flex-[2] h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 h-[1.5vh] bg-[#a9b7c2]/20 rounded mr-[2vw]" />
               <div className="flex-1 text-[1.5vw] text-[#a9b7c2]">X Days</div>
               <div className="flex-1 flex items-center gap-[.5vw]">
                 <div className="w-[.8vw] h-[.8vw] rounded-full bg-[#4ccfa3]" />
                 <span className="text-[1.5vw] text-[#e4ebef]">Normal</span>
               </div>
             </div>
        </div>
      </div>
    </Frame>
  );
}
