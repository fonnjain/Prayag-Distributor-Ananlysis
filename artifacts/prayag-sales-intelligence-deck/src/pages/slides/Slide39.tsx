import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide39() {
  return (
    <Frame number={39} section="Product Tour">
      <SectionTitle eyebrow="SALES" title="Sales: Sales People" subtitle="Individual rep performance." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Individual quota attainment</Bullet>
          <Bullet>Activity and visit tracking</Bullet>
          <Bullet>Distributor coverage per rep</Bullet>
          <Bullet>Productivity benchmarking</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col">
           <div className="flex items-center gap-[2vw] mb-[3vh]">
             <div className="w-[6vw] h-[6vw] rounded-full bg-[#a9b7c2]/20 border-[.2vw] border-[#1389e8] flex items-center justify-center">
               <div className="w-[3vw] h-[3vw] bg-[#a9b7c2]/40 rounded-full" />
             </div>
             <div>
               <div className="h-[2.5vh] w-[15vw] bg-[#f5f2ea]/80 rounded mb-[1vh]" />
               <div className="h-[1.5vh] w-[10vw] bg-[#a9b7c2]/50 rounded" />
             </div>
           </div>
           <div className="flex gap-[2vw]">
             <div className="flex-1 bg-[#1389e8]/10 rounded p-[1.5vw] flex flex-col items-center">
               <div className="text-[2vw] text-[#1389e8] font-display">₹ X.X Cr</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">MTD Sales</div>
             </div>
             <div className="flex-1 bg-[#4ccfa3]/10 rounded p-[1.5vw] flex flex-col items-center">
               <div className="text-[2vw] text-[#4ccfa3] font-display">XX</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">Active Outlets</div>
             </div>
             <div className="flex-1 bg-[#f3b44b]/10 rounded p-[1.5vw] flex flex-col items-center">
               <div className="text-[2vw] text-[#f3b44b] font-display">XX</div>
               <div className="text-[1.5vw] text-[#a9b7c2]">New Signups</div>
             </div>
           </div>
        </div>
      </div>
    </Frame>
  );
}
